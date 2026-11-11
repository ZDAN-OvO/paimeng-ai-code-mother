import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { sqlite } from '@/server/db';
import { newId } from '@/server/id';
import { listProjectFiles, toPosix } from '@/server/projects/workspace';
import { snapshotGitDir } from '@/server/storage';

const MAX_BUFFER = 256 * 1024 * 1024;

function runGit(
  args: string[],
  options: { cwd?: string; input?: Buffer | string; env: NodeJS.ProcessEnv },
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd, env: options.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const error = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else reject(new Error(error || `git exited with ${code}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export class SnapshotError extends Error {}

const queues = new Map<string, Promise<unknown>>();

function serialize<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(
    projectId,
    next.finally(() => {
      if (queues.get(projectId) === next) queues.delete(projectId);
    }),
  );
  return next;
}

async function git(
  projectId: string,
  args: string[],
  options: { input?: Buffer | string; cwd?: string } = {},
) {
  const gitDir = snapshotGitDir(projectId);
  try {
    return await runGit([`--git-dir=${gitDir}`, ...args], {
      cwd: options.cwd,
      input: options.input,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Paimeng',
        GIT_AUTHOR_EMAIL: 'paimeng@localhost',
        GIT_COMMITTER_NAME: 'Paimeng',
        GIT_COMMITTER_EMAIL: 'paimeng@localhost',
      },
    });
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: Buffer }).stderr)
        : error instanceof Error
          ? error.message
          : '未知错误';
    throw new SnapshotError(`Git 快照失败：${detail.trim()}`);
  }
}

async function ensureRepo(projectId: string) {
  const dir = snapshotGitDir(projectId);
  await mkdir(path.dirname(dir), { recursive: true });
  const ready = await stat(path.join(dir, 'HEAD'))
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await runGit(['init', '--bare', '--quiet', dir], {
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  }
}

type TreeEntry = { mode: string; type: 'blob' | 'tree'; sha: string };

async function hashBlob(projectId: string, bytes: Buffer) {
  const { stdout } = await git(projectId, ['hash-object', '-w', '--no-filters', '--stdin'], {
    input: bytes,
  });
  return stdout.toString('utf8').trim();
}

async function writeTree(projectId: string, entries: Map<string, TreeEntry>) {
  const groups = new Map<string, Map<string, TreeEntry>>();
  groups.set('', new Map());
  for (const [fullPath, entry] of entries) {
    const parts = fullPath.split('/');
    let directory = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const child = directory ? `${directory}/${name}` : name;
      if (!groups.has(child)) groups.set(child, new Map());
      groups.get(directory)!.set(name, { mode: '040000', type: 'tree', sha: '' });
      directory = child;
    }
    groups.get(directory)!.set(parts.at(-1)!, entry);
  }
  async function build(directory: string): Promise<string> {
    const children = groups.get(directory) ?? new Map<string, TreeEntry>();
    const lines: Buffer[] = [];
    for (const name of [...children.keys()].sort()) {
      const entry = children.get(name)!;
      const sha =
        entry.type === 'tree' ? await build(directory ? `${directory}/${name}` : name) : entry.sha;
      lines.push(
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.type} ${sha}\t${name}\0`, 'utf8')]),
      );
    }
    const { stdout } = await git(projectId, ['mktree', '-z'], { input: Buffer.concat(lines) });
    return stdout.toString('utf8').trim();
  }
  return build('');
}

/** 把项目当前的非忽略内容写进独立 Git 对象库，返回根 tree。 */
export async function snapshotProject(projectId: string, root: string): Promise<string> {
  return serialize(projectId, async () => {
    await ensureRepo(projectId);
    const { paths } = await listProjectFiles(root, Number.POSITIVE_INFINITY);
    const entries = new Map<string, TreeEntry>();
    for (const relative of paths) {
      const absolute = path.join(root, relative);
      try {
        const info = await lstat(absolute);
        let bytes: Buffer;
        let mode = info.mode & 0o111 ? '100755' : '100644';
        if (info.isSymbolicLink()) {
          bytes = Buffer.from(await readlink(absolute), 'utf8');
          mode = '120000';
        } else if (info.isFile()) {
          bytes = await readFile(absolute);
        } else {
          continue;
        }
        const sha = await hashBlob(projectId, bytes);
        entries.set(toPosix(relative), { mode, type: 'blob', sha });
      } catch {
        // 快照期间消失的文件不进入本次 tree；Diff 会把它当作未变化。
      }
    }
    return writeTree(projectId, entries);
  });
}

export type SnapshotFile = { mode: string; sha: string; bytes: Buffer | null };

async function readTree(projectId: string, tree: string) {
  const { stdout } = await git(projectId, ['ls-tree', '-r', '-z', tree]);
  const map = new Map<string, { mode: string; sha: string }>();
  for (const record of stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    map.set(file, { mode: meta[0], sha: meta[2] });
  }
  return map;
}

async function readBlob(projectId: string, sha: string) {
  const { stdout } = await git(projectId, ['cat-file', 'blob', sha]);
  return stdout;
}

export type TreeChange = {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  before: { exists: boolean; bytes: Buffer; mode: string } | null;
  after: { exists: boolean; bytes: Buffer; mode: string } | null;
};

/** 比较两个 tree；只读取发生变化的 blob。 */
export async function diffTrees(projectId: string, beforeTree: string, afterTree: string) {
  const before = await readTree(projectId, beforeTree);
  const after = await readTree(projectId, afterTree);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: TreeChange[] = [];
  for (const file of paths) {
    const old = before.get(file);
    const next = after.get(file);
    if (old?.sha === next?.sha && old?.mode === next?.mode) continue;
    const kind = !old ? 'added' : !next ? 'deleted' : 'modified';
    changes.push({
      path: file,
      kind,
      before: old
        ? { exists: true, bytes: await readBlob(projectId, old.sha), mode: old.mode }
        : null,
      after: next
        ? { exists: true, bytes: await readBlob(projectId, next.sha), mode: next.mode }
        : null,
    });
  }
  return changes;
}

export async function recordSnapshot(
  projectId: string,
  runId: string,
  phase: string,
  tree: string,
) {
  sqlite()
    .prepare('insert into snapshot (id, project_id, run_id, phase, tree) values (?, ?, ?, ?, ?)')
    .run(newId('snap'), projectId, runId, phase, tree);
}

export function getSnapshot(projectId: string, runId: string, phase: string) {
  return sqlite()
    .prepare(
      'select tree from snapshot where project_id = ? and run_id = ? and phase = ? order by created_at desc limit 1',
    )
    .get(projectId, runId, phase) as { tree: string } | undefined;
}
