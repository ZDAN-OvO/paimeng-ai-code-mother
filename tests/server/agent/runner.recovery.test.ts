import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-recovery-'));
const root = path.join(base, 'project');
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'a.txt'), 'before\n');
process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');
process.env.AI_MODEL = 'fake';
process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';

let db: typeof import('@/server/db');
let runner: typeof import('@/server/agent/runner');
let projectId = '';
let chatId = '';

beforeAll(async () => {
  const projects = await import('@/server/projects');
  const snapshots = await import('@/server/projects/snapshots');
  db = await import('@/server/db');
  runner = await import('@/server/agent/runner');
  const opened = await projects.openProject(root);
  projectId = opened.project.id;
  chatId = opened.chats[0].id;
  const beforeTree = await snapshots.snapshotProject(projectId, root);
  writeFileSync(path.join(root, 'src', 'a.txt'), 'after crash\n');
  db.sqlite()
    .prepare(
      "insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id) values ('run_crashed', ?, 'u_crashed', 'a_crashed', 'fake', 'running', 'old-instance')",
    )
    .run(chatId);
  db.sqlite()
    .prepare(
      "insert into message (id, chat_id, seq, role, parts, status) values ('a_crashed', ?, 1, 'assistant', ?, 'running')",
    )
    .run(
      chatId,
      JSON.stringify([{ id: 'tool-1', type: 'tool', name: 'bash', state: 'running', input: {} }]),
    );
  db.sqlite()
    .prepare(
      "insert into bash_command (id, run_id, tool_call_id, command, cwd, status, before_tree) values ('cmd_crashed', 'run_crashed', 'tool-1', 'sleep 10', ?, 'running', ?)",
    )
    .run(root, beforeTree);
  db.sqlite()
    .prepare(
      "insert into approval (id, run_id, chat_id, tool_call_id, command, cwd, reason, status) values ('approval_crashed', 'run_crashed', ?, 'tool-1', 'sudo true', ?, '使用 sudo', 'pending')",
    )
    .run(chatId, root);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('服务重启恢复', () => {
  it('补记 Bash 中断改动并标记 service_restart', async () => {
    await runner.recoverInterruptedRuns();
    const run = db
      .sqlite()
      .prepare('select status, stop_reason from agent_run where id = ?')
      .get('run_crashed') as { status: string; stop_reason: string };
    expect(run).toEqual({ status: 'stopped', stop_reason: 'service_restart' });
    const command = db
      .sqlite()
      .prepare('select status from bash_command where id = ?')
      .get('cmd_crashed') as { status: string };
    expect(command.status).toBe('interrupted');
    const approval = db
      .sqlite()
      .prepare('select status from approval where id = ?')
      .get('approval_crashed') as { status: string };
    expect(approval.status).toBe('expired');
    const change = db
      .sqlite()
      .prepare(
        'select f.path, f.source, f.attribution, f.change from change_file f join change_set c on c.id = f.change_set_id where c.run_id = ?',
      )
      .get('run_crashed') as Record<string, unknown>;
    expect(change).toMatchObject({
      path: 'src/a.txt',
      source: 'bash',
      attribution: 'uncertain',
      change: 'modified',
    });
    const message = db
      .sqlite()
      .prepare('select parts, status, stop_reason from message where id = ?')
      .get('a_crashed') as { parts: string; status: string; stop_reason: string };
    expect(message.status).toBe('stopped');
    expect(message.stop_reason).toBe('service_restart');
    expect(message.parts).toContain('服务重启');
  });
});
