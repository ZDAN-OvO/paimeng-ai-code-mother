import 'server-only';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runInRuntime } from './commands';
import { RUNTIME_KEEPALIVE } from './plan';

/**
 * 停止屏障：把容器里不属于平台保活进程的进程先冻结再杀掉，然后确认源码在观察窗口内不再变化。
 *
 * 只杀 Docker CLI、只等 `exec` 返回都不能证明进程树结束：detached、setsid、忽略 TERM 的写者
 * 会活下来继续写。冻结（SIGSTOP）到 SIGKILL 之间给每个进程一次不可逃逸的窗口。
 * 容器主进程（`RUNTIME_KEEPALIVE`）和它的子进程必须保留：杀掉它等于结束容器，`exec` 也会一起断。
 * PID 1 是容器 init（`--init`），被遗留的孤儿会被它回收，不会积累成僵尸。
 */

const preamble = `
self=$$
# 容器主进程是 PID 1 的最小 pid 子进程：它先于任何 App 代码创建，pid 由内核单调分配，
# 容器里的代码无法让自己排到它前面。App 留下的孤儿会比它晚创建，pids 都更大。
main=""
for status in /proc/[0-9]*/status; do
  pid=\${status#/proc/}; pid=\${pid%/status}
  [ "$pid" = "$self" ] && continue
  ppid=$(awk '/^PPid:/{print $2}' "$status")
  [ "$ppid" = 1 ] || continue
  cmd=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  case "$cmd" in *"${RUNTIME_KEEPALIVE}"*) ;; *) continue ;; esac
  if [ -z "$main" ] || [ "$pid" -lt "$main" ]; then main=$pid; fi
done
keep="$main"
for status in /proc/[0-9]*/status; do
  pid=\${status#/proc/}; pid=\${pid%/status}
  ppid=$(awk '/^PPid:/{print $2}' "$status")
  case " $keep " in *" $ppid "*) keep="$keep $pid" ;; esac
done
skip() { case " $keep " in *" $1 "*) return 0 ;; esac; return 1; }
`;

const barrierScript = `${preamble}
for status in /proc/[0-9]*/status; do
  pid=\${status#/proc/}; pid=\${pid%/status}
  [ "$pid" = 1 ] && continue
  skip "$pid" && continue
  [ "$pid" = "$self" ] && continue
  grep -Eq "^PPid:[[:space:]]*$self\\$" "$status" && continue
  grep -q '^State:.*Z' "$status" && continue
  kill -STOP "$pid" 2>/dev/null
done
sleep 1
killed=0
for status in /proc/[0-9]*/status; do
  pid=\${status#/proc/}; pid=\${pid%/status}
  [ "$pid" = 1 ] && continue
  skip "$pid" && continue
  [ "$pid" = "$self" ] && continue
  grep -Eq "^PPid:[[:space:]]*$self\\$" "$status" && continue
  grep -q '^State:.*Z' "$status" && continue
  kill -KILL "$pid" 2>/dev/null && killed=$((killed+1))
done
sleep 1
echo "KILLED=$killed"
`;

const countScript = `${preamble}
survivors=0
zombies=0
for status in /proc/[0-9]*/status; do
  pid=\${status#/proc/}; pid=\${pid%/status}
  [ "$pid" = 1 ] && continue
  skip "$pid" && continue
  [ "$pid" = "$self" ] && continue
  grep -Eq "^PPid:[[:space:]]*$self\\$" "$status" && continue
  if grep -q '^State:.*Z' "$status"; then
    zombies=$((zombies+1))
  else
    survivors=$((survivors+1))
  fi
done
echo "COUNTS=$survivors $zombies"
`;

const ignoredEntries = new Set([
  'node_modules',
  'dist',
  '.git',
  '.paimeng-virtual',
  '.paimeng-dev.log',
  '.paimeng-dependencies.json',
  '.paimeng-build.json',
]);

/** 源码树的内容指纹：跳过依赖、产物与运行时私有文件，只对会进 Version 的文件取哈希。 */
export async function digestWorkspace(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignoredEntries.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(relative(root, path));
      hash.update('\0');
      hash.update(await readFile(path).catch(() => Buffer.alloc(0)));
      hash.update('\0');
    }
  };
  await walk(root);
  return hash.digest('hex');
}

export type BarrierResult = {
  killed: number;
  survivors: number;
  zombies: number;
  stable: boolean;
  digest: string;
};

function lineAfter(output: string, prefix: string): string | null {
  const line = output
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

async function processCounts(container: string): Promise<{ survivors: number; zombies: number }> {
  const result = await runInRuntime({
    container,
    command: ['sh', '-lc', countScript],
    timeoutMs: 20_000,
    outputBytes: 4096,
  });
  const [survivors, zombies] = (lineAfter(result.output, 'COUNTS=') ?? '')
    .split(/\s+/)
    .slice(0, 2)
    .map(Number);
  if (!Number.isFinite(survivors) || !Number.isFinite(zombies)) {
    throw new Error(`进程计数无法解析：${result.output.slice(-400)}`);
  }
  return { survivors, zombies };
}

/**
 * 执行一次停止屏障并观察源码。`observeMs` 默认 5 秒，对应计划里「屏障后 5 秒 Workspace hash 不变」。
 */
export async function stopRuntimeWriters(input: {
  container: string;
  workspaceRoot: string;
  observeMs?: number;
  waitMs?: number;
}): Promise<BarrierResult> {
  const stopped = await runInRuntime({
    container: input.container,
    command: ['sh', '-lc', barrierScript],
    timeoutMs: 30_000,
    outputBytes: 4096,
  });
  if (stopped.exitCode !== 0) {
    throw new Error(`停止屏障执行失败（退出码 ${stopped.exitCode}）：${stopped.output.slice(-600)}`);
  }
  const killed = Number(lineAfter(stopped.output, 'KILLED='));
  if (!Number.isFinite(killed)) {
    throw new Error(`停止屏障输出无法解析：${stopped.output.slice(-400)}`);
  }

  const waitDeadline = Date.now() + (input.waitMs ?? 10_000);
  let counts = await processCounts(input.container);
  while (counts.survivors > 0 && Date.now() < waitDeadline) {
    await new Promise((done) => setTimeout(done, 400));
    counts = await processCounts(input.container);
  }

  // 基线取屏障之后：屏障前的最后几笔写入不算「迟到写入」。
  const before = await digestWorkspace(input.workspaceRoot);
  await new Promise((done) => setTimeout(done, input.observeMs ?? 5_000));
  const after = await digestWorkspace(input.workspaceRoot);
  return {
    killed,
    survivors: counts.survivors,
    zombies: counts.zombies,
    stable: before === after,
    digest: after,
  };
}
