import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sqlite } from '@/server/db';
import { newId } from '@/server/id';
import { commandOutputPath } from '@/server/storage';
import { within } from '@/server/projects/workspace';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const TAIL_LINES = 2000;
const TAIL_BYTES = 50 * 1024;

export type BashResult = {
  commandId: string;
  outputId: string;
  outputPath: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  stoppedBy: 'stop' | 'undo' | null;
  truncated: boolean;
  tail: string;
  durationMs: number;
};

type Handle = {
  projectId: string;
  runId: string;
  child: ChildProcess;
  finished: Promise<void>;
  kill: (reason: 'timeout' | 'stop' | 'undo') => void;
};

const active = new Map<string, Set<Handle>>();
const handlesByRun = new Map<string, Set<Handle>>();

function register(handle: Handle) {
  let byProject = active.get(handle.projectId);
  if (!byProject) {
    byProject = new Set();
    active.set(handle.projectId, byProject);
  }
  byProject.add(handle);
  let byRun = handlesByRun.get(handle.runId);
  if (!byRun) {
    byRun = new Set();
    handlesByRun.set(handle.runId, byRun);
  }
  byRun.add(handle);
}

function unregister(handle: Handle) {
  active.get(handle.projectId)?.delete(handle);
  handlesByRun.get(handle.runId)?.delete(handle);
}

const SECRET_ENV =
  /(API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI|ANTHROPIC|GEMINI|AI_BASE_URL|AI_MODEL|DATABASE_PATH|NPM_TOKEN|GITHUB_TOKEN)/i;

/** Bash 不继承派蒙的模型凭据和宿主密钥；保留 PATH、HOME 等运行所需变量。 */
export function bashEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  env.PAIMENG = '1';
  return env;
}

function stripQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, '');
}

/** 只做关键词级审批，不是隔离边界；界面会明确说明这一点。 */
export function approvalReason(command: string, root: string) {
  const text = command.trim();
  if (/(^|[;&|]\s*)sudo\b/.test(text)) return '使用 sudo 会修改系统权限';
  if (/(^|\s)(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^;&|]*\s(-g|--global)\b/.test(text)) {
    return '全局安装会修改项目外的环境';
  }
  if (/(^|\s)git\s+(commit|push)\b/.test(text)) return 'Git 提交或推送会写入用户仓库历史';
  for (const segment of text.split(/(?:&&|\|\||[;|])/)) {
    const match = segment.trim().match(/^(rm|mv)\s+(.+)$/);
    if (!match) continue;
    const args = match[2]
      .split(/\s+/)
      .map(stripQuotes)
      .filter((arg) => arg && !arg.startsWith('-'));
    for (const arg of args) {
      if (arg.startsWith('~') || arg.startsWith('/') || arg.startsWith('..')) {
        const target = path.resolve(root, arg.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
        if (!within(root, target)) return `${match[1]} 的目标在项目目录之外`;
      }
    }
  }
  return null;
}

class Tail {
  private lines: string[] = [];
  private bytes = 0;
  private partial = '';

  push(chunk: string) {
    const pieces = (this.partial + chunk).split('\n');
    this.partial = pieces.pop() ?? '';
    for (const line of pieces) this.add(line);
    if (this.partial) this.trim();
  }

  private add(line: string) {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    this.trim();
  }

  private trim() {
    while (this.lines.length > TAIL_LINES || this.bytes > TAIL_BYTES) {
      if (this.lines.length === 0) break;
      const removed = this.lines.shift()!;
      this.bytes -= Buffer.byteLength(removed) + 1;
    }
  }

  value() {
    const lines = [...this.lines];
    if (this.partial) lines.push(this.partial);
    let value = lines.join('\n');
    if (Buffer.byteLength(value) > TAIL_BYTES) {
      const buffer = Buffer.from(value);
      value = buffer.subarray(buffer.length - TAIL_BYTES).toString('utf8');
    }
    return value;
  }

  get truncated() {
    return this.lines.length >= TAIL_LINES || this.bytes >= TAIL_BYTES || Boolean(this.partial);
  }
}

export async function runBash(options: {
  projectId: string;
  runId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  approvalId?: string;
  onStart?: (commandId: string) => void;
}): Promise<BashResult> {
  const commandId = newId('cmd');
  const outputPath = commandOutputPath(options.runId, commandId);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const started = Date.now();
  sqlite()
    .prepare(
      'insert into bash_command (id, run_id, tool_call_id, command, cwd, status, output_path, approval_id) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      commandId,
      options.runId,
      options.toolCallId,
      options.command,
      options.cwd,
      'running',
      outputPath,
      options.approvalId ?? null,
    );
  options.onStart?.(commandId);

  const child = spawn('bash', ['-c', options.command], {
    cwd: options.cwd,
    env: bashEnvironment(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createWriteStream(outputPath, { flags: 'w' });
  const tail = new Tail();
  const decoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => {
    output.write(chunk);
    tail.push(decoder.write(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output.write(chunk);
    tail.push(decoder.write(chunk));
  });

  let timedOut = false;
  let stopped = false;
  let stoppedBy: 'stop' | 'undo' | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (signal: NodeJS.Signals, after?: NodeJS.Timeout) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* 已经退出。 */
      }
    }
    if (after) killTimer = after;
  };

  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const handle: Handle = {
    projectId: options.projectId,
    runId: options.runId,
    child,
    finished,
    kill: (reason) => {
      if (reason === 'timeout') timedOut = true;
      else {
        stopped = true;
        stoppedBy = reason;
      }
      terminate('SIGTERM');
      const timer = setTimeout(() => terminate('SIGKILL'), 3000);
      timer.unref();
    },
  };
  register(handle);

  const timeout = setTimeout(() => handle.kill('timeout'), timeoutMs);
  timeout.unref();

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  await new Promise<void>((resolve) => output.end(resolve));
  tail.push(decoder.end());
  unregister(handle);
  resolveFinished();
  const durationMs = Date.now() - started;
  const status = timedOut ? 'timeout' : stopped ? 'stopped' : exit.code === 0 ? 'done' : 'failed';
  sqlite()
    .prepare(
      'update bash_command set status = ?, exit_code = ?, finished_at = ?, output_truncated = ? where id = ?',
    )
    .run(status, exit.code, Date.now(), tail.truncated ? 1 : 0, commandId);
  return {
    commandId,
    outputId: commandId,
    outputPath,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    stopped,
    stoppedBy,
    truncated: tail.truncated,
    tail: tail.value(),
    durationMs,
  };
}

async function stopHandles(handles: Set<Handle>, reason: 'stop' | 'undo') {
  for (const handle of [...handles]) handle.kill(reason);
  await Promise.race([
    Promise.allSettled([...handles].map((handle) => handle.finished)),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

/** 撤销优先：先终止同项目所有 Bash，并等进程组收尾。 */
export async function killProjectBash(projectId: string, reason: 'undo' | 'stop' = 'undo') {
  const handles = active.get(projectId);
  if (handles) await stopHandles(handles, reason);
}

export async function killRunBash(runId: string, reason: 'undo' | 'stop' = 'stop') {
  const handles = handlesByRun.get(runId);
  if (handles) await stopHandles(handles, reason);
}

export function bashRunning(projectId: string) {
  return (active.get(projectId)?.size ?? 0) > 0;
}
