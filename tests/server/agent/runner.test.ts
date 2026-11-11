import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-runner-'));
const root = path.join(base, 'project');
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'note.txt'), 'hello\n');
process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');

let server: Server;
let projectId = '';
let chatId = '';
let db: typeof import('@/server/db');
let runner: typeof import('@/server/agent/runner');
let approvals: typeof import('@/server/agent/approvals');
let projects: typeof import('@/server/projects');

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function toolChunk(id: string, name: string, input: unknown) {
  return chunk(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    null,
  );
}

function done(res: import('node:http').ServerResponse, finish = 'tool_calls') {
  res.write(chunk({}, finish));
  res.write('data: [DONE]\n\n');
  res.end();
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
    const body = await readBody(request);
    const parsed = JSON.parse(body) as { messages?: { role: string; content?: unknown }[] };
    const messages = parsed.messages ?? [];
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
    const lastUser = messages[lastUserIndex];
    const prompt =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? '');
    const toolResults = messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === 'tool').length;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (prompt.includes('SLOW')) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      response.write(chunk({ role: 'assistant', content: '慢慢完成' }));
      done(response, 'stop');
      return;
    }
    if (prompt.includes('PLAN55') && toolResults < 55) {
      response.write(toolChunk(`call_${toolResults}`, 'read', { path: 'src/note.txt' }));
      done(response);
      return;
    }
    if (prompt.includes('ERRORS3') && toolResults < 3) {
      response.write(toolChunk(`call_${toolResults}`, 'bash', { command: 'exit 1' }));
      done(response);
      return;
    }
    if (prompt.includes('APPROVAL') && toolResults < 1) {
      response.write(toolChunk('call_approval', 'bash', { command: 'sudo echo approved' }));
      done(response);
      return;
    }
    response.write(chunk({ role: 'assistant', content: '完成' }));
    done(response, 'stop');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  process.env.AI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.AI_MODEL = 'fake';
  process.env.AI_API_KEY = 'test';

  projects = await import('@/server/projects');
  db = await import('@/server/db');
  runner = await import('@/server/agent/runner');
  approvals = await import('@/server/agent/approvals');
  const opened = await projects.openProject(root);
  projectId = opened.project.id;
  chatId = opened.chats[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

async function waitForRun(runId: string, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const row = db
      .sqlite()
      .prepare('select status, stop_reason, step_count, error from agent_run where id = ?')
      .get(runId) as
      | { status: string; stop_reason: string | null; step_count: number; error: string | null }
      | undefined;
    if (row && row.status !== 'running' && row.status !== 'awaiting_approval') return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} 超时未结束`);
}

describe('Agent 运行器', () => {
  it('不按默认 20 步停止，连续 55 步后自然结束', async () => {
    const accepted = await runner.startRun(chatId, 'PLAN55');
    const row = await waitForRun(accepted.runId);
    expect(row.status).toBe('succeeded');
    const assistant = db
      .sqlite()
      .prepare('select status, parts from message where id = ?')
      .get(accepted.messageId) as { status: string; parts: string };
    expect(assistant.status).toBe('succeeded');
    expect((JSON.parse(assistant.parts) as unknown[]).length).toBeGreaterThan(1);
    expect(row.step_count).toBe(56);
    const steps = db
      .sqlite()
      .prepare('select count(*) as count from agent_step where run_id = ?')
      .get(accepted.runId) as { count: number };
    expect(steps.count).toBe(56);
  }, 90_000);

  it('连续三次工具错误不会触发失败预算，仍可自然结束', async () => {
    const accepted = await runner.startRun(chatId, 'ERRORS3');
    const row = await waitForRun(accepted.runId);
    expect(row.status).toBe('succeeded');
    const assistant = db
      .sqlite()
      .prepare('select status, parts from message where id = ?')
      .get(accepted.messageId) as { status: string; parts: string };
    expect(assistant.status).toBe('succeeded');
    expect((JSON.parse(assistant.parts) as unknown[]).length).toBeGreaterThan(1);
    const executions = db
      .sqlite()
      .prepare("select count(*) as count from tool_execution where run_id = ? and state = 'done'")
      .get(accepted.runId) as { count: number };
    expect(executions.count).toBe(3);
  }, 60_000);

  it('需要批准时暂停，批准后仅执行一次', async () => {
    const accepted = await runner.startRun(chatId, 'APPROVAL');
    let approvalId = '';
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const row = db
        .sqlite()
        .prepare("select id from approval where run_id = ? and status = 'pending'")
        .get(accepted.runId) as { id: string } | undefined;
      if (row) {
        approvalId = row.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(approvalId).not.toBe('');
    expect(approvals.decideApproval(approvalId, 'approved').changed).toBe(true);
    expect(approvals.decideApproval(approvalId, 'approved').changed).toBe(false);
    runner.reflectApproval(approvalId, 'approved');
    const row = await waitForRun(accepted.runId);
    expect(row.status).toBe('succeeded');
    const assistant = db
      .sqlite()
      .prepare('select status, parts from message where id = ?')
      .get(accepted.messageId) as { status: string; parts: string };
    expect(assistant.status).toBe('succeeded');
    expect((JSON.parse(assistant.parts) as unknown[]).length).toBeGreaterThan(1);
    const commands = db
      .sqlite()
      .prepare('select command, status from bash_command where run_id = ?')
      .all(accepted.runId) as { command: string; status: string }[];
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe('sudo echo approved');
    expect(['done', 'failed']).toContain(commands[0].status);
  }, 60_000);

  it('等待批准时停止会过期审批且不执行命令', async () => {
    const second = projects.createChat(projectId, { title: '停止审批' });
    const accepted = await runner.startRun(second.id, 'APPROVAL stop');
    let approvalId = '';
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const row = db
        .sqlite()
        .prepare("select id from approval where run_id = ? and status = 'pending'")
        .get(accepted.runId) as { id: string } | undefined;
      if (row) {
        approvalId = row.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(approvalId).not.toBe('');
    expect(await runner.stopRun(second.id)).toBe(true);
    expect((await waitForRun(accepted.runId)).status).toBe('stopped');
    const approval = db
      .sqlite()
      .prepare('select status from approval where id = ?')
      .get(approvalId) as {
      status: string;
    };
    expect(approval.status).toBe('expired');
    const commands = db
      .sqlite()
      .prepare('select count(*) as count from bash_command where run_id = ?')
      .get(accepted.runId) as { count: number };
    expect(commands.count).toBe(0);
    expect(await runner.stopRun(second.id)).toBe(false);
  }, 30_000);

  it('同项目不同对话可并行，同一对话重复发送返回 409', async () => {
    const second = projects.createChat(projectId, { title: '并行对话' });
    const [left, right] = await Promise.all([
      runner.startRun(chatId, 'PARALLEL left'),
      runner.startRun(second.id, 'PARALLEL right'),
    ]);
    expect((await waitForRun(left.runId)).status).toBe('succeeded');
    expect((await waitForRun(right.runId)).status).toBe('succeeded');

    const slow = await runner.startRun(chatId, 'SLOW again');
    await expect(runner.startRun(chatId, 'duplicate')).rejects.toMatchObject({ status: 409 });
    await runner.stopRun(chatId);
    await waitForRun(slow.runId);
  }, 30_000);

  it('停止会结束当前轮', async () => {
    const accepted = await runner.startRun(chatId, 'SLOW');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runner.stopRun(chatId)).toBe(true);
    const row = await waitForRun(accepted.runId);
    expect(row.status).toBe('stopped');
    expect(row.stop_reason).toBe('user_stop');
  }, 30_000);
});
