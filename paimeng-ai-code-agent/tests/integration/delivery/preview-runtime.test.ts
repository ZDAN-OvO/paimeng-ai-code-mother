import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer as createNetServer, connect, type Server as NetServer } from 'node:net';
import type { CodeGenType } from '@/shared/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreviewServer, type DevServerTarget } from '@/server/delivery/preview';

const appA = { id: '920000001', codeGenType: 'react_project' as const };
const appB = { id: '920000002', codeGenType: 'react_project' as const };
const appKey = (app: { id: string; codeGenType: CodeGenType }) => `${app.codeGenType}_${app.id}`;

let root = '';
let previewPort = 0;
let server: Server | undefined;
let devA: Server;
let devB: Server;
let wsServer: NetServer;
let devAPort = 0;
let devBPort = 0;
let wsPort = 0;
let seenPaths: string[] = [];
let wsSeen: string[] = [];
const targets = new Map<string, DevServerTarget | null>();
const previousOrigin = process.env.PREVIEW_ORIGIN;

function freePort() {
  const probe = createNetServer();
  return new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function devServer(label: string) {
  return createHttpServer((req, res) => {
    seenPaths.push(`${label} ${req.url}`);
    if ((req.url ?? '').endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'upstream=1', 'x-upstream': label });
      res.end(`console.log("${label}")`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><h1>${label} live</h1></body></html>`);
  });
}

function rawGet(path: string, options: { method?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: previewPort, path, method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${previewPort}` },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 直接用原始 socket 发升级请求：断言代理把 101 与后续双向字节都转给了 dev server。 */
function upgrade(path: string) {
  return new Promise<{ head: string; socket: ReturnType<typeof connect> }>((resolve, reject) => {
    const socket = connect(previewPort, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${previewPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: http://127.0.0.1:' + previewPort,
        '', '',
      ].join('\r\n'));
    });
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        resolve({ head: buffer, socket });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'paimeng-preview-runtime-'));
  // 静态回落：没有 dev server 时仍然服务工作区里的 index.html。
  // 构建类应用的静态回落目录是 code_output/<key>/dist（legacyDelivery 的约定）。
  await mkdir(join(root, 'code_output', appKey(appA), 'dist'), { recursive: true });
  await writeFile(join(root, 'code_output', appKey(appA), 'dist', 'index.html'), '<!doctype html><html><body><h1>静态回落</h1></body></html>');

  devA = devServer('dev-a');
  devB = devServer('dev-b');
  devAPort = await freePort();
  devBPort = await freePort();
  await new Promise<void>(resolve => devA.listen(devAPort, '127.0.0.1', resolve));
  await new Promise<void>(resolve => devB.listen(devBPort, '127.0.0.1', resolve));

  // 最小 HMR 握手替身：收到升级请求后回 101，再把后续字节加前缀回显。
  wsServer = createNetServer(socket => {
    socket.once('data', chunk => {
      wsSeen.push(chunk.toString());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', data => socket.write('echo:' + data.toString()));
    });
  });
  wsPort = await freePort();
  await new Promise<void>(resolve => wsServer.listen(wsPort, '127.0.0.1', resolve));

  previewPort = await freePort();
  process.env.PREVIEW_ORIGIN = `http://127.0.0.1:${previewPort}`;
  server = await createPreviewServer({
    runtimeRoot: root,
    devServerCacheMs: 0,
    devServerFor: async app => targets.get(appKey(app)) ?? null,
    // 锁住/恢复的浏览器行为由 E2E（真实页面 → 代理 → dev server）断言，这里不重复实现细节。
    writeAuthorityOf: async () => false,
  });
  await new Promise<void>(resolve => server!.listen(previewPort, '127.0.0.1', resolve));
});

beforeEach(() => {
  seenPaths = [];
  wsSeen = [];
  targets.clear();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  for (const item of [devA, devB, wsServer]) await new Promise<void>(resolve => item.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  if (previousOrigin === undefined) delete process.env.PREVIEW_ORIGIN;
  else process.env.PREVIEW_ORIGIN = previousOrigin;
});

describe('Preview 按 App 代理 dev server', () => {
  it('存活时把 HTTP 请求转发给对应 App 的 dev server，注入编辑桥接、CSP 并保留预览前缀', async () => {
    targets.set(appKey(appA), { status: 'ready', port: devAPort });
    const response = await rawGet(`/preview/${appKey(appA)}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('dev-a live');
    expect(response.body).toContain('data-paimeng-editor');
    expect(response.headers['content-security-policy']).toContain("connect-src 'self' ws: wss:");
    expect(response.headers['content-security-policy']).toContain('frame-ancestors http://localhost:3000');
    expect(response.headers['set-cookie']).toBeUndefined();
    // dev server 的 base 就是预览前缀，代理不改写路径。
    expect(seenPaths).toContain(`dev-a /preview/${appKey(appA)}/`);

    const asset = await rawGet(`/preview/${appKey(appA)}/src/main.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('application/javascript');
    expect(asset.body).toBe('console.log("dev-a")');
    expect(asset.headers['set-cookie']).toBeUndefined();
  });

  it('不同 App 各用各的端口，内容不串用', async () => {
    targets.set(appKey(appA), { status: 'ready', port: devAPort });
    targets.set(appKey(appB), { status: 'ready', port: devBPort });
    expect((await rawGet(`/preview/${appKey(appA)}/`)).body).toContain('dev-a live');
    expect((await rawGet(`/preview/${appKey(appB)}/`)).body).toContain('dev-b live');
    expect(seenPaths).toEqual(expect.arrayContaining([`dev-a /preview/${appKey(appA)}/`, `dev-b /preview/${appKey(appB)}/`]));
    expect(seenPaths.some(path => path.includes(appKey(appA)) && path.startsWith('dev-b'))).toBe(false);
  });

  it('运行时启动中/失败时给出明确状态页，不泄露内部错误', async () => {
    targets.set(appKey(appA), { status: 'starting', port: null });
    const starting = await rawGet(`/preview/${appKey(appA)}/`);
    expect(starting.status).toBe(503);
    expect(starting.headers['retry-after']).toBe('2');
    expect(starting.body).toContain('data-paimeng-preview-state="starting"');
    expect(starting.body).toContain('应用运行时正在启动');
    expect(starting.body).not.toContain('docker');

    targets.set(appKey(appA), { status: 'failed', port: null });
    const failed = await rawGet(`/preview/${appKey(appA)}/`);
    expect(failed.status).toBe(503);
    expect(failed.body).toContain('data-paimeng-preview-state="failed"');
    expect(failed.body).toContain('仍可查看上一次构建的页面');
  });

  it('没有 dev server 时回落到静态产物，写请求仍然拒绝', async () => {
    targets.set(appKey(appA), null);
    const response = await rawGet(`/preview/${appKey(appA)}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('静态回落');
    expect(response.body).toContain('data-paimeng-editor');
    expect((await rawGet(`/preview/${appKey(appA)}/`, { method: 'POST' })).status).toBe(405);
  });

  it('HMR websocket 的升级请求与后续字节被转发给 dev server', async () => {
    targets.set(appKey(appA), { status: 'ready', port: wsPort });
    const { head, socket } = await upgrade(`/preview/${appKey(appA)}/`);
    expect(head).toContain('101 Switching Protocols');
    expect(wsSeen.join('')).toContain(`GET /preview/${appKey(appA)}/ HTTP/1.1`);
    // Node 的 HTTP 解析器把头部名小写化；代理按原样转发即可，协议本身大小写不敏感。
    expect(wsSeen.join('')).toMatch(/upgrade: websocket/i);
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once('data', chunk => resolve(chunk.toString()));
      socket.once('error', reject);
      socket.write('hmr-ping');
    });
    expect(echoed).toBe('echo:hmr-ping');
    socket.destroy();
  });

  it('没有 dev server 时 websocket 直接断开，不会连到别的 App', async () => {
    targets.set(appKey(appA), { status: 'ready', port: devAPort });
    await new Promise<void>((resolve, reject) => {
      const socket = connect(previewPort, '127.0.0.1', () => {
        socket.write(`GET /preview/${appKey(appB)}/ HTTP/1.1\r\nHost: 127.0.0.1:${previewPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      });
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('websocket 没有被断开')); });
    });
    expect(seenPaths.some(path => path.startsWith('dev-a') && path.includes(appKey(appB)))).toBe(false);
  });
});
