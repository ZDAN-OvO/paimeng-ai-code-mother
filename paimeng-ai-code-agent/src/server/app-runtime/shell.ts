import 'server-only';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../infra/config';
import { runtimeContainerName, runtimePaths, RUNTIME_WORKDIR, type RuntimeApp } from './plan';

/**
 * App runtime 内的命令执行器：模型通过 shell 工具使用它。
 *
 * 边界（父 spec「App runtime」与 #140）：
 * - 只在当前 App 的容器里执行，工作目录就是这个 App 的持久 Workspace（`/work`）；
 * - 不注入任何平台环境变量；容器本身的 env 白名单在 `plan.runtimeEnvironment`；
 * - 单条命令有超时、每轮条数由 harness 的 attempt 预算限制、返回给模型的输出截断，完整输出留在运行时日志；
 * - 超时/取消时按进程组终止：容器内包装脚本自己看门，宿主再兜底一次，不留下继续修改源码的命令。
 */

export type RuntimeShellResult = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  truncated: boolean;
  logPath: string;
  durationMs: number;
};

const hostKillGraceMs = 5_000;

/**
 * 容器内包装脚本。位置参数：$1 超时标记文件、$2 命令、$3 超时秒数。
 * `setsid` 让命令成为新会话首进程（pid == 进程组 id），再把 pid 写进标记文件；
 * 看门狗到点按进程组发 TERM/KILL，宿主的 `docker exec` 被中断也不会留下写文件的命令。
 */
export const runtimeShellScript = [
  `setsid sh -c 'echo $$ > "$1"; exec sh -lc "$2"' paimeng-shell "$1" "$2" &`,
  'child=$!',
  '(',
  '  remaining=$(( $3 * 2 ))',
  '  while [ "$remaining" -gt 0 ]; do',
  '    kill -0 "$child" 2>/dev/null || exit 0',
  '    sleep 0.5',
  '    remaining=$(( remaining - 1 ))',
  '  done',
  '  : > "$1.timedout"',
  '  pid=$(cat "$1" 2>/dev/null)',
  '  [ -n "$pid" ] && kill -TERM -"$pid" 2>/dev/null',
  '  sleep 1',
  '  [ -n "$pid" ] && kill -KILL -"$pid" 2>/dev/null',
  ') &',
  'watchdog=$!',
  'wait "$child"',
  'code=$?',
  'kill "$watchdog" 2>/dev/null',
  'exit "$code"',
].join('\n');

export function runtimeShellExecArgs(input: { app: RuntimeApp; command: string; timeoutMs: number; pidFile: string }): string[] {
  return [
    'exec', '-w', RUNTIME_WORKDIR, runtimeContainerName(input.app), 'sh', '-c', runtimeShellScript,
    'paimeng-shell', input.pidFile, input.command, String(Math.max(1, Math.ceil(input.timeoutMs / 1000))),
  ];
}

/** 宿主兜底：和容器内看门狗一样按进程组终止，先 TERM 再 KILL。 */
function hostKillArgs(input: { app: RuntimeApp; pidFile: string }): string[] {
  return [
    'exec', runtimeContainerName(input.app), 'sh', '-c',
    `pid=$(cat "$1" 2>/dev/null); [ -n "$pid" ] && kill -TERM -"$pid" 2>/dev/null; sleep 1; [ -n "$pid" ] && kill -KILL -"$pid" 2>/dev/null; true`,
    'paimeng-shell', input.pidFile,
  ];
}

/** 返回给模型的输出只保留最后一段：错误通常在末尾。 */
export function truncateShellOutput(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= limit) return { text, truncated: false };
  return { text: bytes.subarray(bytes.byteLength - limit).toString('utf8'), truncated: true };
}

function dockerOnce(args: string[], timeoutMs: number): Promise<{ code: number | null }> {
  return new Promise(done => {
    const child = spawn('docker', args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); done({ code: null }); });
    child.once('close', code => { clearTimeout(timer); done({ code }); });
  });
}

function outputLogPath(app: RuntimeApp): string {
  const directory = join(runtimePaths(getConfig().runtimeRoot, app).base, 'shell');
  return join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}.log`);
}

/** 在 App runtime 内执行一条命令；容器不存在时抛错（调用方给出可读反馈）。 */
export async function runRuntimeShell(input: {
  app: RuntimeApp;
  command: string;
  timeoutMs?: number;
  outputBytes?: number;
  signal?: AbortSignal;
  logPath?: string;
}): Promise<RuntimeShellResult> {
  const config = getConfig();
  const timeoutMs = input.timeoutMs ?? config.appRuntime.shell.timeoutMs;
  const outputBytes = input.outputBytes ?? config.appRuntime.shell.outputBytes;
  const logPath = input.logPath ?? outputLogPath(input.app);
  await mkdir(dirname(logPath), { recursive: true });
  const pidFile = `/tmp/.paimeng-shell-${randomUUID()}.pid`;
  const args = runtimeShellExecArgs({ app: input.app, command: input.command, timeoutMs, pidFile });
  const log = createWriteStream(logPath);
  const startedAt = Date.now();
  let buffer = '';
  let cancelled = false;
  let timedOut = false;

  const append = (chunk: Buffer) => {
    log.write(chunk);
    buffer += chunk.toString('utf8');
    // 只保留尾部窗口：完整内容已经写进日志，内存里不需要留整份输出。
    const keep = Math.max(outputBytes * 4, 64 * 1024);
    if (buffer.length > keep) buffer = buffer.slice(buffer.length - keep);
  };

  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  // 重试几次按进程组终止：命令刚启动时 pid 文件可能还没写出来，单次 kill 会落空。
  const terminate = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await dockerOnce(hostKillArgs({ app: input.app, pidFile }), 10_000);
      if (child.exitCode !== null) return;
      await new Promise(done => setTimeout(done, 300));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  // 容器内的看门狗负责正常超时；宿主定时器只是兜底（docker exec 卡死时仍能返回）。
  const hostTimer = setTimeout(() => { timedOut = true; void terminate(); }, timeoutMs + hostKillGraceMs);
  const abort = () => { cancelled = true; void terminate(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();

  const exitCode = await new Promise<number | null>(done => {
    child.once('error', () => done(null));
    child.once('close', code => done(code));
  });
  clearTimeout(hostTimer);
  input.signal?.removeEventListener('abort', abort);
  await new Promise<void>(done => log.end(done));
  const durationMs = Date.now() - startedAt;

  // docker exec 自己失败（容器不存在、Docker 不可用）与命令退出码要区分开。
  if (exitCode === null) throw new Error(`无法在 App runtime 内执行命令：docker exec 未能启动（${logPath}）`);
  if (!timedOut && !cancelled && durationMs >= timeoutMs - 500 && exitCode !== 0) {
    // 看门狗可能刚好在预算末尾终止命令：以容器里的超时标记为准，避免把正常失败误报成超时。
    timedOut = await dockerOnce(['exec', runtimeContainerName(input.app), 'test', '-f', `${pidFile}.timedout`], 10_000).then(result => result.code === 0).catch(() => false);
  }
  const visible = truncateShellOutput(buffer, outputBytes);
  return {
    exitCode,
    timedOut,
    cancelled,
    output: visible.text,
    truncated: visible.truncated,
    logPath,
    durationMs,
  };
}
