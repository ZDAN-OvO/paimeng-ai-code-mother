import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-changes-'));
const root = path.join(base, 'project');
mkdirSync(path.join(root, 'src'), { recursive: true });
process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');

let projectId = '';
let changes: typeof import('@/server/agent/changes');
let db: typeof import('@/server/db');

beforeAll(async () => {
  const projects = await import('@/server/projects');
  db = await import('@/server/db');
  changes = await import('@/server/agent/changes');
  const opened = await projects.openProject(root);
  projectId = opened.project.id;
  db.sqlite()
    .prepare(
      'insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('run_old_process', opened.chats[0].id, 'u', 'a', 'fake', 'running', 'old-instance');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function pending(pathname: string, before: string | null, after: string) {
  const beforeBytes = before === null ? Buffer.alloc(0) : Buffer.from(before);
  return changes.beginFileIntent({
    projectId,
    runId: 'run_old_process',
    path: pathname,
    operation: 'write',
    source: 'tool',
    attribution: 'exact',
    before: {
      exists: before !== null,
      bytes: beforeBytes,
      mode: before !== null ? '100644' : undefined,
    },
    after: { exists: true, bytes: Buffer.from(after), mode: '100644' },
  });
}

function changeFor(pathname: string) {
  const row = db
    .sqlite()
    .prepare('select * from change_file where path = ? order by created_at desc limit 1')
    .get(pathname) as Record<string, unknown> | undefined;
  return row;
}

describe('写盘意图恢复', () => {
  it('文件已写但结果未提交时补记改动', async () => {
    writeFileSync(path.join(root, 'src', 'written.txt'), 'after\n');
    const id = pending('src/written.txt', null, 'after\n');
    await changes.recoverPendingFileIntents(projectId);
    const operation = db
      .sqlite()
      .prepare('select state from file_operation where id = ?')
      .get(id) as { state: string };
    expect(operation.state).toBe('recovered');
    expect(changeFor('src/written.txt')).toMatchObject({ change: 'added', undo_state: 'applied' });
  });

  it('文件仍是改前状态时不产生改动', async () => {
    writeFileSync(path.join(root, 'src', 'unchanged.txt'), 'before\n');
    const id = pending('src/unchanged.txt', 'before\n', 'after\n');
    await changes.recoverPendingFileIntents(projectId);
    const operation = db
      .sqlite()
      .prepare('select state from file_operation where id = ?')
      .get(id) as { state: string };
    expect(operation.state).toBe('discarded');
    expect(changeFor('src/unchanged.txt')).toBeUndefined();
    expect(readFileSync(path.join(root, 'src', 'unchanged.txt'), 'utf8')).toBe('before\n');
  });

  it('实际内容既非改前也非改后时保留实际内容并标不确定', async () => {
    writeFileSync(path.join(root, 'src', 'external.txt'), 'external\n');
    pending('src/external.txt', 'before\n', 'after\n');
    await changes.recoverPendingFileIntents(projectId);
    expect(changeFor('src/external.txt')).toMatchObject({
      change: 'modified',
      attribution: 'uncertain',
    });
    expect(readFileSync(path.join(root, 'src', 'external.txt'), 'utf8')).toBe('external\n');
  });
});
