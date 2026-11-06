#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S2：Vite dev server 放在 `/preview/<appKey>/` 子路径后面，HTTP 与 HMR websocket
 * 经过同一个反向代理时是否仍然工作；两个 App 是否互不串流。
 *
 * 代理是 spike 里最小的真实实现：HTTP 透传 + HTML 注入 + upgrade 原始字节透传。
 * 不引入 http-proxy 等依赖，避免「库帮我们做对了」掩盖路径/端口问题。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../../..');
const evidenceDir = join(here, '..', 'evidence');
const work = join(process.env.SPIKE_WORK ?? '/tmp/app-runtime-spike-20261103', 's2');
const viteEnv = join(work, 'vite-env');
const requireFromRepo = createRequire(join(repoRoot, 'paimeng-ai-code-agent/package.json'));
const { chromium } = requireFromRepo('playwright');

const PROXY_PORT = 3101;
const HOST_PORT = 3100;
const APPS = [
  { key: 'react_project_700000001', port: 5173, label: 'A' },
  { key: 'react_project_700000002', port: 5174, label: 'B' },
];
const children = new Set();
let proxy;
let host;

const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitForText(scope, selector, text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await scope.locator(selector).textContent().catch(() => null);
    if (current === text) return;
    await sleep(50);
  }
  throw new Error(`等待 ${selector} 文本 ${text} 超时，当前 ${current}`);
}

function startProcess(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  child.on('exit', code => { if (code && code !== 0) console.error(`[${name}] exit ${code}\n${log.slice(-2000)}`); });
  return { child, log: () => log };
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error(`等待 ${url} 超时`);
}

function appFiles(key, title) {
  return {
    'index.html': `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${key}</title></head><body><div id="app"><h1 id="marker">${title}</h1></div><script type="module" src="/src/main.js"></script></body></html>`,
    'src/main.js': `import './dep.js';\ndocument.getElementById('app').dataset.booted = 'yes';\n`,
    'src/dep.js': depSource(title),
  };
}

function depSource(title) {
  return `export const title = ${JSON.stringify(title)};
const el = document.getElementById('marker');
if (el) el.textContent = title;
if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod) document.getElementById('marker').textContent = mod.title;
  });
}
`;
}

async function writeApp(app, title) {
  const root = join(work, app.key);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(appFiles(app.key, title))) await writeFile(join(root, path), content);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: app.key, private: true, type: 'module' }, null, 2));
  return root;
}

function devServer(app, root) {
  const vite = join(viteEnv, 'node_modules/vite/bin/vite.js');
  const base = `/preview/${app.key}/`;
  const started = startProcess(`vite-${app.label}`, process.execPath, [vite, '--host', '127.0.0.1', '--port', String(app.port), '--strictPort', '--base', base], root, { NODE_ENV: 'development' });
  return { ...started, base };
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'content-length']);

function proxyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP.has(name.toLowerCase())));
}

function csp() {
  return "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors http://127.0.0.1:" + HOST_PORT + '; sandbox allow-scripts allow-same-origin allow-forms allow-popups';
}

function injectBridge(html) {
  const script = '<script data-spike-bridge>window.__spikeBridge = true;</script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + '</body>') : html + script;
}

function proxyHttp(req, res, target) {
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${target.port}`, 'accept-encoding': 'identity', connection: 'close' },
  }, response => {
    const type = String(response.headers['content-type'] ?? '');
    const headers = proxyHeaders(response.headers);
    if (type.includes('text/html')) {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.from(injectBridge(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(response.statusCode ?? 200, {
          ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length),
          'cache-control': 'no-store', 'content-security-policy': csp(),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
      response.on('error', () => { res.writeHead(502); res.end('upstream error'); });
      return;
    }
    res.writeHead(response.statusCode ?? 200, { ...headers, 'cache-control': 'no-store' });
    response.pipe(res);
  });
  upstream.setTimeout(20_000, () => upstream.destroy(new Error('proxy timeout')));
  upstream.on('error', () => { res.writeHead(502); res.end('upstream error'); });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, target) {
  const upstream = connect(target.port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

async function startProxy(apps) {
  const targets = new Map(apps.map(app => [`/preview/${app.key}/`, app]));
  const server = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    const target = [...targets.entries()].find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!target) { res.writeHead(404); res.end('unknown app'); return; }
    proxyHttp(req, res, target);
  });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    const target = [...targets.entries()].find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!target) { socket.destroy(); return; }
    proxyUpgrade(req, socket, head, target);
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(PROXY_PORT, '127.0.0.1', resolveListen); });
  return server;
}

async function startHost() {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><body style="margin:0"><iframe title="preview" src="http://127.0.0.1:${PROXY_PORT}/preview/${APPS[0].key}/" style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(HOST_PORT, '127.0.0.1', resolveListen); });
  return server;
}

async function freePortCheck(port) {
  await new Promise((resolveCheck, reject) => {
    const probe = createNetServer();
    probe.once('error', error => reject(new Error(`端口 ${port} 不可用：${error.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolveCheck));
  });
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await freePortCheck(PROXY_PORT);
  await freePortCheck(HOST_PORT);
  const apps = [];
  for (const spec of APPS) {
    const root = await writeApp(spec, `first-${spec.label}`);
    const server = devServer(spec, root);
    await waitForUrl(`http://127.0.0.1:${spec.port}/preview/${spec.key}/`);
    apps.push({ ...spec, root, ...server });
  }
  proxy = await startProxy(apps);
  host = await startHost();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const sockets = [];
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('websocket', socket => {
    const record = { url: socket.url(), frames: [] };
    sockets.push(record);
    socket.on('framereceived', event => { if (record.frames.length < 60) record.frames.push(String(event.payload).slice(0, 2000)); });
    socket.on('socketerror', error => record.error = String(error));
  });

  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      vite: JSON.parse(await readFile(join(viteEnv, 'node_modules/vite/package.json'), 'utf8')).version,
      node: process.version,
      chromium: browser.version(),
      proxyPort: PROXY_PORT,
      hostPort: HOST_PORT,
      apps: APPS.map(({ key, port }) => ({ key, port })),
      hmrPortPolicy: '__HMR_PORT__ 未设置（只传 --base），客户端回退到页面端口 3101',
    },
    checks: {},
    sockets,
    consoleMessages,
    pageErrors,
    failedRequests,
  };

  // 1. iframe 内首次加载：桥接脚本、CSP、模块图
  await page.goto(`http://127.0.0.1:${HOST_PORT}/`);
  const frame = page.frameLocator('iframe[title="preview"]');
  await frame.locator('#marker').waitFor({ state: 'visible', timeout: 30_000 });
  result.checks.initial = {
    marker: await frame.locator('#marker').textContent(),
    bridge: await frame.locator('html').evaluate(() => window.__spikeBridge === true),
    booted: await frame.locator('#app').getAttribute('data-booted'),
    iframeSrc: await page.locator('iframe').getAttribute('src'),
  };

  // 2. 不刷新页面的 HMR：改 dep.js，等待 DOM 更新；window 探针必须还在
  await frame.locator('html').evaluate(() => { window.__probe = 'hmr-no-reload'; });
  const updates = [];
  for (let index = 0; index < 5; index += 1) {
    const title = `hmr-${index}-${Date.now()}`;
    const at = Date.now();
    await writeFile(join(apps[0].root, 'src/dep.js'), depSource(title));
    await waitForText(frame, '#marker', title);
    updates.push({ title, ms: Date.now() - at });
  }
  result.checks.hmr = {
    updates,
    probeAfterUpdates: await frame.locator('html').evaluate(() => window.__probe),
    websocketUrls: sockets.map(socket => socket.url),
    frameCount: sockets.reduce((sum, socket) => sum + socket.frames.length, 0),
    updateFrameSeen: sockets.some(socket => socket.frames.some(payload => payload.includes('vite:beforeUpdate') || payload.includes('"type":"update"') || payload.includes('"type":"js-update"'))),
  };

  // 3. 记录一张截图（宿主页面 + iframe）
  await page.screenshot({ path: join(evidenceDir, 's2-hmr.png'), fullPage: true });

  // 4. 第二个 App：同代理、不同端口，内容不串
  const pageB = await context.newPage();
  const socketsB = [];
  pageB.on('websocket', socket => socketsB.push({ url: socket.url(), frames: [] }));
  await pageB.goto(`http://127.0.0.1:${PROXY_PORT}/preview/${apps[1].key}/`);
  await pageB.locator('#marker').waitFor({ state: 'visible', timeout: 30_000 });
  result.checks.secondApp = {
    marker: await pageB.locator('#marker').textContent(),
    bridge: await pageB.locator('html').evaluate(() => window.__spikeBridge === true),
    sockets: socketsB.map(socket => socket.url),
  };
  await pageB.locator('html').evaluate(() => { window.__probeB = 'b'; });
  const titleB = `hmr-b-${Date.now()}`;
  await writeFile(join(apps[1].root, 'src/dep.js'), depSource(titleB));
  await waitForText(pageB, '#marker', titleB);
  result.checks.secondApp.hmrProbe = await pageB.locator('html').evaluate(() => window.__probeB);
  result.checks.crossTalk = {
    aStillOwnTitle: (await frame.locator('#marker').textContent()) !== titleB,
    bOwnTitle: (await pageB.locator('#marker').textContent()) === titleB,
  };

  // 5. SPA 深链：/preview/<key>/settings 必须回 index.html
  const deep = await page.goto(`http://127.0.0.1:${PROXY_PORT}/preview/${apps[0].key}/settings`);
  result.checks.deepLink = {
    status: deep?.status() ?? null,
    markerVisible: await page.locator('#marker').isVisible().catch(() => false),
    title: await page.title(),
  };

  // 6. 资源与 HMR 错误统计
  result.checks.errors = {
    pageErrors,
    failedRequests,
    consoleErrors: consoleMessages.filter(message => message.type === 'error'),
    consoleWarnings: consoleMessages.filter(message => message.type === 'warning'),
  };

  await writeFile(join(evidenceDir, 's2.json'), JSON.stringify(result, null, 2));
  const summary = [
    '# S2 结果：Vite HMR 经过 `/preview/<appKey>/` 子路径代理',
    '',
    `- Vite ${result.environment.vite}，Chromium ${result.environment.chromium}，代理端口 ${PROXY_PORT}`,
    `- HMR 端口策略：${result.environment.hmrPortPolicy}`,
    `- 首次加载：marker=${result.checks.initial.marker}，bridge=${result.checks.initial.bridge}，booted=${result.checks.initial.booted}`,
    `- 5 次 HMR：${updates.map(item => `${item.ms}ms`).join(' / ')}；探针保留=${result.checks.hmr.probeAfterUpdates}`,
    `- WebSocket：${result.checks.hmr.websocketUrls.join(', ')}；帧数 ${result.checks.hmr.frameCount}；update 帧=${result.checks.hmr.updateFrameSeen}`,
    `- 第二个 App：marker=${result.checks.secondApp.marker}，HMR 后探针=${result.checks.secondApp.hmrProbe}，串流=${!result.checks.crossTalk.aStillOwnTitle || !result.checks.crossTalk.bOwnTitle}`,
    `- SPA 深链：status=${result.checks.deepLink.status}，marker 可见=${result.checks.deepLink.markerVisible}`,
    `- 错误：pageErrors=${pageErrors.length}，requestfailed=${failedRequests.length}，consoleErrors=${result.checks.errors.consoleErrors.length}`,
    '',
  ].join('\n');
  await writeFile(join(evidenceDir, 's2-summary.md'), summary + '\n');
  console.log(summary);

  await browser.close();
}

try {
  await main();
} finally {
  if (proxy) await new Promise(resolveClose => proxy.close(resolveClose)).catch(() => undefined);
  if (host) await new Promise(resolveClose => host.close(resolveClose)).catch(() => undefined);
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await sleep(500);
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}
