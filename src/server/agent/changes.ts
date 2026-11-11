import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { diffLines } from 'diff';
import path from 'node:path';
import { instanceId, sqlite } from '@/server/db';
import { newId } from '@/server/id';
import { projectRoot } from '@/server/projects';
import { pauseProject } from '@/server/concurrency';
import { killProjectBash } from '@/server/agent/bash';
import { publish } from '@/server/agent/events';
import { notifyUndo } from '@/server/agent/notices';
import { invalidatePath } from '@/server/agent/observations';
import { listProjectFiles, resolveEntryPath } from '@/server/projects/workspace';
import { getBlobSync, putBlobSync } from '@/server/storage';
import type {
  ChangeFile,
  ChangeSet,
  ChangeSetStatus,
  ChangeSource,
  FileIndex,
} from '@/shared/api/schemas';

export type FileState = { exists: boolean; bytes: Buffer; mode?: string };

export type RecordChange = {
  projectId: string;
  runId: string;
  changeSetId?: string | null;
  path: string;
  source: ChangeSource;
  attribution: 'exact' | 'uncertain';
  before: FileState;
  after: FileState;
  operation: 'write' | 'edit' | 'delete' | 'bash' | 'undo';
  detail?: string;
  intentId?: string | null;
};

export type FileIntent = {
  projectId: string;
  runId: string;
  changeSetId?: string | null;
  path: string;
  operation: 'write' | 'edit' | 'delete' | 'bash' | 'undo';
  source: ChangeSource;
  attribution: 'exact' | 'uncertain';
  before: FileState;
  after: FileState;
  detail?: string;
};

const MAX_DISPLAY_BYTES = 512 * 1024;

function now() {
  return Date.now();
}

function sameFile(before: FileState, after: FileState) {
  return (
    before.exists === after.exists && before.mode === after.mode && before.bytes.equals(after.bytes)
  );
}

function looksBinary(bytes: Buffer) {
  return bytes.includes(0);
}

function mergedSource(current: ChangeSource, next: ChangeSource): ChangeSource {
  return current === next ? current : 'mixed';
}

function ensureChangeSet(projectId: string, runId: string, requested?: string | null) {
  const database = sqlite();
  if (requested) {
    const existing = database
      .prepare('select id from change_set where id = ? and project_id = ?')
      .get(requested, projectId) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const byRun = database
    .prepare('select id from change_set where run_id = ? and project_id = ?')
    .get(runId, projectId) as { id: string } | undefined;
  if (byRun) return byRun.id;

  const run = database
    .prepare('select chat_id, assistant_message_id from agent_run where id = ?')
    .get(runId) as { chat_id: string; assistant_message_id: string } | undefined;
  const seqRow = database
    .prepare('select coalesce(max(seq), 0) as seq from change_set where project_id = ?')
    .get(projectId) as { seq: number };
  const id = newId('change');
  database
    .prepare(
      `insert into change_set (id, project_id, chat_id, message_id, run_id, seq, summary, status, created_at)
       values (?, ?, ?, ?, ?, ?, '本轮文件改动', 'applied', ?)`,
    )
    .run(
      id,
      projectId,
      run?.chat_id ?? '',
      run?.assistant_message_id ?? null,
      runId,
      Number(seqRow.seq) + 1,
      now(),
    );
  if (run?.assistant_message_id) {
    database
      .prepare('update message set change_set_id = ? where id = ?')
      .run(id, run.assistant_message_id);
  }
  database.prepare('update agent_run set change_set_id = ? where id = ?').run(id, runId);
  return id;
}

function countChanges(before: FileState, after: FileState) {
  if (looksBinary(before.bytes) || looksBinary(after.bytes)) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before.bytes.toString('utf8'), after.bytes.toString('utf8'))) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export function recordOperation(input: {
  projectId: string;
  runId: string;
  changeSetId?: string | null;
  path: string;
  operation: string;
  source: ChangeSource;
  attribution: 'exact' | 'uncertain';
  detail?: string;
}) {
  sqlite()
    .prepare(
      `insert into file_operation (id, project_id, run_id, change_set_id, path, operation, source, attribution, detail, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('op'),
      input.projectId,
      input.runId,
      input.changeSetId ?? null,
      input.path,
      input.operation,
      input.source,
      input.attribution,
      input.detail ?? null,
      now(),
    );
}

export function recordChange(input: RecordChange) {
  if (sameFile(input.before, input.after)) return null;
  const database = sqlite();
  const changeSetId = ensureChangeSet(input.projectId, input.runId, input.changeSetId);
  const existing = database
    .prepare('select * from change_file where change_set_id = ? and path = ?')
    .get(changeSetId, input.path) as Record<string, unknown> | undefined;

  let before = input.before;
  const after = input.after;
  let source = input.source;
  let attribution = input.attribution;
  if (existing) {
    if (Boolean(existing.before_exists) && existing.before_blob) {
      before = {
        exists: true,
        bytes: getBlobSync(String(existing.before_blob)),
        mode: (existing.before_mode as string | null) ?? undefined,
      };
    } else {
      before = { exists: false, bytes: Buffer.alloc(0) };
    }
    source = mergedSource(existing.source as ChangeSource, source);
    attribution = existing.attribution === 'uncertain' ? 'uncertain' : attribution;
    database.prepare('delete from change_file where id = ?').run(String(existing.id));
  }

  const beforeStored = before.exists ? putBlobSync(input.projectId, before.bytes).ref : null;
  const afterStored = after.exists ? putBlobSync(input.projectId, after.bytes).ref : null;
  const binary =
    (before.exists && looksBinary(before.bytes)) || (after.exists && looksBinary(after.bytes));
  const counts = countChanges(before, after);
  const change = !before.exists ? 'added' : !after.exists ? 'deleted' : 'modified';

  database
    .prepare(
      `insert into change_file (
        id, change_set_id, path, change, source, attribution, undo_state,
        before_blob, after_blob, before_exists, after_exists, before_size, after_size,
        before_binary, after_binary, before_mode, after_mode, added, removed, binary, created_at
      ) values (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('file'),
      changeSetId,
      input.path,
      change,
      source,
      attribution,
      beforeStored,
      afterStored,
      before.exists ? 1 : 0,
      after.exists ? 1 : 0,
      before.exists ? before.bytes.length : 0,
      after.exists ? after.bytes.length : 0,
      before.exists && looksBinary(before.bytes) ? 1 : 0,
      after.exists && looksBinary(after.bytes) ? 1 : 0,
      before.mode ?? null,
      after.mode ?? null,
      counts.added,
      counts.removed,
      binary ? 1 : 0,
      now(),
    );

  recordOperation({
    projectId: input.projectId,
    runId: input.runId,
    changeSetId,
    path: input.path,
    operation: input.operation,
    source: input.source,
    attribution: input.attribution,
    detail: input.detail,
  });
  if (input.intentId) commitFileIntent(input.intentId, changeSetId);
  database.prepare('update project set updated_at = ? where id = ?').run(now(), input.projectId);
  return { changeSetId };
}

/** 写盘前记录意图；服务在写盘和提交记录之间崩溃时，启动恢复据此核对。 */
export function beginFileIntent(input: FileIntent): string {
  const id = newId('intent');
  sqlite()
    .prepare(
      `insert into file_operation (
        id, project_id, run_id, change_set_id, path, operation, source, attribution, state,
        before_blob, after_blob, before_exists, after_exists, before_mode, after_mode, detail, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.runId,
      input.changeSetId ?? null,
      input.path,
      input.operation,
      input.source,
      input.attribution,
      input.before.exists ? putBlobSync(input.projectId, input.before.bytes).ref : null,
      input.after.exists ? putBlobSync(input.projectId, input.after.bytes).ref : null,
      input.before.exists ? 1 : 0,
      input.after.exists ? 1 : 0,
      input.before.mode ?? null,
      input.after.mode ?? null,
      input.detail ?? null,
      now(),
    );
  return id;
}

export function commitFileIntent(intentId: string, changeSetId?: string | null) {
  sqlite()
    .prepare(
      "update file_operation set state = 'committed', change_set_id = coalesce(?, change_set_id) where id = ?",
    )
    .run(changeSetId ?? null, intentId);
}

export function abortFileIntent(intentId: string, reason: string) {
  sqlite()
    .prepare(
      "update file_operation set state = 'failed', detail = ? where id = ? and state = 'pending'",
    )
    .run(reason, intentId);
}

async function currentState(projectId: string, relative: string): Promise<FileState> {
  const root = await projectRoot(projectId);
  const target = await resolveEntryPath(root, relative);
  const info = await lstat(target.absolute).catch(() => null);
  if (!info) return { exists: false, bytes: Buffer.alloc(0) };
  if (info.isSymbolicLink()) {
    return { exists: true, bytes: Buffer.from(await readlink(target.absolute)), mode: '120000' };
  }
  return {
    exists: true,
    bytes: await readFile(target.absolute),
    mode: info.mode & 0o111 ? '100755' : '100644',
  };
}

/** 恢复上一个进程留下的写盘意图：匹配改后则补记，匹配改前则丢弃，否则保守记为不确定。 */
export async function recoverPendingFileIntents(projectId?: string) {
  const rows = sqlite()
    .prepare(
      `select o.*, r.instance_id as run_instance
       from file_operation o left join agent_run r on r.id = o.run_id
       where o.state = 'pending'
         and (o.run_id is null or r.instance_id is null or r.instance_id != ?)
         ${projectId ? 'and o.project_id = ?' : ''}
       order by o.created_at asc`,
    )
    .all(...(projectId ? [instanceId(), projectId] : [instanceId()])) as Record<string, unknown>[];
  for (const row of rows) {
    const id = String(row.id);
    try {
      const before: FileState = row.before_exists
        ? {
            exists: true,
            bytes: getBlobSync(String(row.before_blob)),
            mode: (row.before_mode as string | null) ?? undefined,
          }
        : { exists: false, bytes: Buffer.alloc(0) };
      const after: FileState = row.after_exists
        ? {
            exists: true,
            bytes: getBlobSync(String(row.after_blob)),
            mode: (row.after_mode as string | null) ?? undefined,
          }
        : { exists: false, bytes: Buffer.alloc(0) };
      const current = await currentState(String(row.project_id), String(row.path));
      if (sameFile(current, before)) {
        sqlite()
          .prepare("update file_operation set state = 'discarded', detail = ? where id = ?")
          .run('恢复时文件已是改前状态，未写入', id);
        continue;
      }
      const exact = sameFile(current, after);
      recordChange({
        projectId: String(row.project_id),
        runId: String(row.run_id),
        changeSetId: row.change_set_id ? String(row.change_set_id) : null,
        path: String(row.path),
        source: row.source as ChangeSource,
        attribution: exact ? (row.attribution as 'exact' | 'uncertain') : 'uncertain',
        before,
        after: current,
        operation: row.operation as RecordChange['operation'],
        detail: exact
          ? '服务中断后核对实际文件，补记已落盘的改动'
          : '服务中断后文件与预期不一致，保留实际内容并标为不确定',
      });
      sqlite()
        .prepare("update file_operation set state = 'recovered', detail = ? where id = ?")
        .run(exact ? '已核对并补记' : '实际内容与预期不一致，已按实际内容补记', id);
    } catch (error) {
      sqlite()
        .prepare("update file_operation set state = 'uncertain', detail = ? where id = ?")
        .run(`恢复失败：${error instanceof Error ? error.message : String(error)}`, id);
    }
  }
}

function toChangeFile(row: Record<string, unknown>): ChangeFile {
  return {
    path: String(row.path),
    change: row.change as ChangeFile['change'],
    source: row.source as ChangeFile['source'],
    attribution: row.attribution as ChangeFile['attribution'],
    undoState: row.undo_state as ChangeFile['undoState'],
    added: Number(row.added),
    removed: Number(row.removed),
    binary: Boolean(row.binary),
  };
}

function changeStatus(files: ChangeFile[]): ChangeSetStatus {
  if (files.length === 0) return 'applied';
  const undone = files.filter((file) => file.undoState === 'undone').length;
  if (undone === 0) return 'applied';
  return undone === files.length ? 'undone' : 'partially_undone';
}

function toChangeSet(row: Record<string, unknown>, files: ChangeFile[]): ChangeSet {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    chatId: String(row.chat_id),
    messageId: row.message_id ? String(row.message_id) : null,
    summary: String(row.summary),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    status: changeStatus(files),
    files,
  };
}

export function changeSetById(projectId: string, changeSetId: string): ChangeSet | null {
  const database = sqlite();
  const row = database
    .prepare('select * from change_set where id = ? and project_id = ?')
    .get(changeSetId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const files = database
    .prepare('select * from change_file where change_set_id = ? order by created_at asc, path asc')
    .all(changeSetId) as Record<string, unknown>[];
  return toChangeSet(row, files.map(toChangeFile));
}

export function changesetsForProject(projectId: string, cursor?: number, limit = 20) {
  const database = sqlite();
  const rows = database
    .prepare(
      `select * from change_set where project_id = ? and (? is null or seq < ?)
       order by seq desc limit ?`,
    )
    .all(projectId, cursor ?? null, cursor ?? null, limit) as Record<string, unknown>[];
  const changeSets = rows.map((row) => {
    const files = database
      .prepare('select * from change_file where change_set_id = ? order by path asc')
      .all(String(row.id)) as Record<string, unknown>[];
    return toChangeSet(row, files.map(toChangeFile));
  });
  return {
    changeSets,
    nextCursor: rows.length === limit ? Number(rows[rows.length - 1].seq) : null,
  };
}

export function changeFileFor(projectId: string, changeSetId: string, relative: string) {
  const row = sqlite()
    .prepare(
      `select f.* from change_file f join change_set c on c.id = f.change_set_id
       where f.change_set_id = ? and f.path = ? and c.project_id = ?`,
    )
    .get(changeSetId, relative, projectId) as Record<string, unknown> | undefined;
  return row ? toChangeFile(row) : null;
}

function version(ref: unknown, exists: boolean, size: number, binary: boolean) {
  if (!exists) return { exists: false, size: 0, binary: false, content: null, truncated: false };
  if (binary) return { exists: true, size, binary: true, content: null, truncated: false };
  const bytes = ref ? getBlobSync(String(ref)) : Buffer.alloc(0);
  const truncated = bytes.length > MAX_DISPLAY_BYTES;
  return {
    exists: true,
    size,
    binary: false,
    content: (truncated ? bytes.subarray(0, MAX_DISPLAY_BYTES) : bytes).toString('utf8'),
    truncated,
  };
}

export function changeVersions(projectId: string, changeSetId: string, relative: string) {
  const changeSet = changeSetById(projectId, changeSetId);
  if (!changeSet) return null;
  const row = sqlite()
    .prepare('select * from change_file where change_set_id = ? and path = ?')
    .get(changeSetId, relative) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    changeSet,
    file: toChangeFile(row),
    before: version(
      row.before_blob,
      Boolean(row.before_exists),
      Number(row.before_size),
      Boolean(row.before_binary),
    ),
    after: version(
      row.after_blob,
      Boolean(row.after_exists),
      Number(row.after_size),
      Boolean(row.after_binary),
    ),
  };
}

async function restoreFile(projectId: string, relative: string, row: Record<string, unknown>) {
  const root = await projectRoot(projectId);
  const target = await resolveEntryPath(root, relative);
  const current = await lstat(target.absolute).catch(() => null);
  const beforeExists = Boolean(row.before_exists);
  const beforeMode = row.before_mode ? String(row.before_mode) : undefined;

  if (!beforeExists) {
    if (current) {
      if (current.isDirectory()) throw new Error('目标已变成目录，拒绝自动撤销');
      await unlink(target.absolute);
    }
    return;
  }
  if (beforeMode === '120000') {
    if (current) await rm(target.absolute, { force: true });
    const linkTarget = getBlobSync(String(row.before_blob)).toString('utf8');
    await symlink(linkTarget, target.absolute);
    return;
  }
  const bytes = getBlobSync(String(row.before_blob));
  await mkdir(path.dirname(target.absolute), { recursive: true });
  const temporary = `${target.absolute}.paimeng-${newId('tmp')}`;
  await writeFile(temporary, bytes);
  if (beforeMode === '100755') await chmod(temporary, 0o755);
  await rename(temporary, target.absolute);
}

const undoLocks = new Map<string, Promise<unknown>>();

function withUndoLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = undoLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(task, task);
  undoLocks.set(
    projectId,
    next.finally(() => {
      if (undoLocks.get(projectId) === next) undoLocks.delete(projectId);
    }),
  );
  return next;
}

async function refreshIndex(projectId: string) {
  const root = await projectRoot(projectId);
  const listed = await listProjectFiles(root, 5000);
  const fileIndex: FileIndex = {
    paths: listed.paths,
    truncated: listed.truncated,
    limit: 5000,
    indexedAt: new Date().toISOString(),
  };
  sqlite()
    .prepare('update project set file_index = ?, updated_at = ? where id = ?')
    .run(JSON.stringify(fileIndex), now(), projectId);
}

export async function undoChangeFile(projectId: string, changeSetId: string, relative: string) {
  return withUndoLock(projectId, async () => {
    const database = sqlite();
    const row = database
      .prepare(
        `select f.* from change_file f join change_set c on c.id = f.change_set_id
         where f.change_set_id = ? and f.path = ? and c.project_id = ?`,
      )
      .get(changeSetId, relative, projectId) as Record<string, unknown> | undefined;
    if (!row) return null;

    if (row.undo_state === 'applied') {
      // 撤销优先：先阻止该项目的所有 Bash，再暂停文件写入并恢复。
      await killProjectBash(projectId, 'undo');
      await pauseProject(projectId, async () => {
        await restoreFile(projectId, relative, row);
        database
          .prepare("update change_file set undo_state = 'undone', undone_at = ? where id = ?")
          .run(now(), String(row.id));
        const files = database
          .prepare('select * from change_file where change_set_id = ?')
          .all(changeSetId) as Record<string, unknown>[];
        const status = changeStatus(files.map(toChangeFile));
        database.prepare('update change_set set status = ? where id = ?').run(status, changeSetId);
        invalidatePath(relative);
        await refreshIndex(projectId);
        notifyUndo(projectId, [relative]);
        publish(projectId, {
          type: 'files-changed',
          runId: 'user_undo',
          changeSetId,
          paths: [relative],
        });
      });
    }

    const updatedRow = database
      .prepare('select * from change_file where change_set_id = ? and path = ?')
      .get(changeSetId, relative) as Record<string, unknown>;
    const changeSet = changeSetById(projectId, changeSetId);
    if (!changeSet) return null;
    return { changeSet, file: toChangeFile(updatedRow) };
  });
}

export function lastWriter(projectId: string, relative: string) {
  return sqlite()
    .prepare(
      `select run_id, source, created_at from file_operation
       where project_id = ? and path = ? and operation != 'read'
       order by created_at desc limit 1`,
    )
    .get(projectId, relative) as { run_id: string; source: string; created_at: number } | undefined;
}
