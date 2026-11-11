import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-api-'));
const root = path.join(base, 'project');
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'a.txt'), 'one\ntwo\nthree\n');
symlinkSync(root, path.join(base, 'link'));
process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');
delete process.env.AI_MODEL;
delete process.env.AI_BASE_URL;

let openRoute: typeof import('@/app/api/projects/open/route');
let projectRoute: typeof import('@/app/api/projects/[id]/route');
let fileRoute: typeof import('@/app/api/projects/[id]/file/route');
let chatsRoute: typeof import('@/app/api/projects/[id]/chats/route');
let db: typeof import('@/server/db');

beforeAll(async () => {
  openRoute = await import('@/app/api/projects/open/route');
  projectRoute = await import('@/app/api/projects/[id]/route');
  fileRoute = await import('@/app/api/projects/[id]/file/route');
  chatsRoute = await import('@/app/api/projects/[id]/chats/route');
  db = await import('@/server/db');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function open(workspacePath: string) {
  return openRoute.POST(
    new Request('http://test/api/projects/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath }),
    }),
  );
}

describe('项目接口', () => {
  it('同一目录和软链复用项目，并返回入口对话', async () => {
    const first = await open(root);
    expect(first.status).toBe(201);
    const body = (await first.json()) as { project: { id: string }; chats: { id: string }[] };
    expect(body.chats.length).toBeGreaterThan(0);
    const second = await open(path.join(base, 'link'));
    expect(second.status).toBe(201);
    const again = (await second.json()) as { project: { id: string } };
    expect(again.project.id).toBe(body.project.id);
  });

  it('空目录可以打开并创建初始对话', async () => {
    const empty = path.join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    const response = await open(empty);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      project: { name: string; fileIndex: { paths: string[] } };
      chats: unknown[];
    };
    expect(body.project.name).toBe('empty');
    expect(body.project.fileIndex.paths).toEqual([]);
    expect(body.chats).toHaveLength(1);
  });

  it('拒绝相对路径、不存在路径和根目录', async () => {
    expect((await open('relative/path')).status).toBe(400);
    expect((await open(path.join(base, 'missing'))).status).toBe(400);
    expect((await open('/')).status).toBe(400);
  });

  it('按需读取文件并拒绝越界路径', async () => {
    const opened = (await (await open(root)).json()) as { project: { id: string } };
    const id = opened.project.id;
    const file = await fileRoute.GET(
      new Request(`http://test/api/projects/${id}/file?path=src/a.txt&offset=2&limit=1`),
      { params: Promise.resolve({ id }) },
    );
    expect(file.status).toBe(200);
    expect(await file.json()).toMatchObject({
      path: 'src/a.txt',
      offset: 2,
      limit: 1,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
    const attack = await fileRoute.GET(
      new Request(
        `http://test/api/projects/${id}/file?path=${encodeURIComponent('../outside.txt')}`,
      ),
      { params: Promise.resolve({ id }) },
    );
    expect(attack.status).toBeGreaterThanOrEqual(400);
  });

  it('新建对话并拒绝在运行中删除项目', async () => {
    const opened = (await (await open(root)).json()) as {
      project: { id: string };
      chats: { id: string }[];
    };
    const id = opened.project.id;
    const created = await chatsRoute.POST(
      new Request(`http://test/api/projects/${id}/chats`, { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id }) },
    );
    expect(created.status).toBe(201);
    const chat = (await created.json()) as { id: string };
    db.sqlite()
      .prepare(
        "insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id) values ('run_active', ?, 'u', 'a', 'fake', 'running', 'instance')",
      )
      .run(chat.id);
    const denied = await projectRoute.DELETE(new Request('http://test', { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });
    expect(denied.status).toBe(409);
    db.sqlite().prepare("update agent_run set status = 'succeeded' where id = 'run_active'").run();
    const outputDir = path.join(base, 'data', 'command-output', 'run_active');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'command.log'), 'full output\n');
    const deleted = await projectRoute.DELETE(new Request('http://test', { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });
    expect(deleted.status).toBe(204);
    expect(existsSync(path.join(root, 'src', 'a.txt'))).toBe(true);
    expect(existsSync(path.join(base, 'data', 'projects', id))).toBe(false);
    expect(existsSync(outputDir)).toBe(false);
    const missing = await projectRoute.GET(new Request('http://test'), {
      params: Promise.resolve({ id }),
    });
    expect(missing.status).toBe(404);
  });

  it('审批路由只允许一次决定，重复请求返回 409', async () => {
    const opened = (await (await open(root)).json()) as {
      project: { id: string };
      chats: { id: string }[];
    };
    const chatId = opened.chats[0].id;
    db.sqlite()
      .prepare(
        "insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id) values ('run_approval', ?, 'u', 'a', 'fake', 'awaiting_approval', 'instance')",
      )
      .run(chatId);
    db.sqlite()
      .prepare(
        "insert into message (id, chat_id, seq, role, parts, status) values ('a', ?, 99, 'assistant', '[]', 'awaiting_approval')",
      )
      .run(chatId);
    const approvalRoute =
      await import('@/app/api/chats/[id]/runs/[runId]/approvals/[approvalId]/route');
    const approvals = await import('@/server/agent/approvals');
    const controller = new AbortController();
    const pending = approvals.requestApproval({
      approvalId: 'approval_test',
      runId: 'run_approval',
      chatId,
      toolCallId: 'call_test',
      command: 'sudo true',
      cwd: root,
      reason: '使用 sudo',
      signal: controller.signal,
    });
    const request = () =>
      new Request('http://test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });
    const params = {
      params: Promise.resolve({
        id: chatId,
        runId: 'run_approval',
        approvalId: 'approval_test',
      }),
    };
    const first = await approvalRoute.POST(request(), params);
    expect(first.status).toBe(200);
    expect(await pending).toBe('approved');
    const second = await approvalRoute.POST(request(), params);
    expect(second.status).toBe(409);
    db.sqlite()
      .prepare("update agent_run set status = 'succeeded' where id = 'run_approval'")
      .run();
  });

  it('没有配置模型时发送消息明确失败', async () => {
    const opened = (await (await open(root)).json()) as {
      project: { id: string };
      chats: { id: string }[];
    };
    const messages = await import('@/app/api/chats/[id]/messages/route');
    const response = await messages.POST(
      new Request(`http://test/api/chats/${opened.chats[0].id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      }),
      { params: Promise.resolve({ id: opened.chats[0].id }) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('模型'),
    });
  });
});
