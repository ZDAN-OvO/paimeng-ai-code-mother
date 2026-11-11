import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SseEvent } from '@/shared/api/schemas';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-sse-'));
const root = path.join(base, 'project');
mkdirSync(root, { recursive: true });
process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');

let server: Server;
let chatId = '';
let events: typeof import('@/app/api/chats/[id]/events/route');
let runner: typeof import('@/server/agent/runner');

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-sse',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on('data', (value) => parts.push(Buffer.from(value)));
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    request.on('error', reject);
  });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(chunk({ role: 'assistant', content: 'a' }));
    for (const text of ['b', 'c', 'd', 'e', 'f']) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      response.write(chunk({ content: text }));
    }
    response.write(chunk({}, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  process.env.AI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.AI_MODEL = 'fake';
  process.env.AI_API_KEY = 'test';
  const projects = await import('@/server/projects');
  runner = await import('@/server/agent/runner');
  events = await import('@/app/api/chats/[id]/events/route');
  const opened = await projects.openProject(root);
  chatId = opened.chats[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

function messageText(event: Extract<SseEvent, { type: 'snapshot' }>) {
  return (event.message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matcher: (events: SseEvent[]) => boolean,
) {
  const decoder = new TextDecoder();
  let buffer = '';
  const list: SseEvent[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block.startsWith('data: ')) list.push(JSON.parse(block.slice(6)) as SseEvent);
      boundary = buffer.indexOf('\n\n');
    }
    if (matcher(list)) break;
    if (list.some((event) => event.type === 'finish')) break;
  }
  return list;
}

describe('SSE 重连续传', () => {
  it('重连快照是权威状态，不重复已包含的文本', async () => {
    await runner.startRun(chatId, 'STREAM');
    while (!runner.activeRunForChat(chatId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const controller = new AbortController();
    const first = await events.GET(
      new Request(`http://test/api/chats/${chatId}/events`, { signal: controller.signal }),
      { params: Promise.resolve({ id: chatId }) },
    );
    const reader = first.body!.getReader();
    const before = await readUntil(reader, (list) =>
      list.some((event) => event.type === 'text-delta'),
    );
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const snapshot = before.find((event) => event.type === 'snapshot');
    const delta = before.find((event) => event.type === 'text-delta');
    expect(snapshot?.type).toBe('snapshot');
    expect(delta?.type).toBe('text-delta');
    const since = Math.max(...before.map((event) => event.seq));

    const second = await events.GET(
      new Request(`http://test/api/chats/${chatId}/events?since=${since}`),
      { params: Promise.resolve({ id: chatId }) },
    );
    const after = await readUntil(second.body!.getReader(), () => false);
    const snapshotAfter = after.find((event) => event.type === 'snapshot');
    expect(snapshotAfter?.type).toBe('snapshot');
    let text = snapshotAfter?.type === 'snapshot' ? messageText(snapshotAfter) : '';
    const replayed: string[] = [];
    for (const event of after) {
      if (event.type === 'text-delta' && event.seq > since) {
        text += event.delta;
        replayed.push(event.delta);
      }
    }
    expect(replayed.length).toBeGreaterThan(0);
    expect(text).toBe('abcdef');
    expect(after.some((event) => event.type === 'finish')).toBe(true);
  }, 30_000);
});
