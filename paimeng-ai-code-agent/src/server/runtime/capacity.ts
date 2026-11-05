import 'server-only';

/**
 * App runtime 容量策略的纯函数部分：谁算空闲、该驱逐谁、排队位置和内存口径。
 *
 * 真正占用槽位的事实由 `app_runtime` 台账与排队记录决定（见 `scheduler.ts`）；
 * 这里只做与数据库无关的判断，好让「空闲回收 / LRU / 匿名内存」这些规则能被单测固定住。
 */

export type RuntimeCandidate = {
  appId: string;
  status: 'starting' | 'ready';
  /** 数据库里的 UTC 朴素时间戳（`YYYY-MM-DD HH:mm:ss.SSS`）。 */
  lastActivityAt: string;
  /** 这一 App 现在是否持有 Write authority：持有的绝不回收、绝不驱逐。 */
  writeAuthority: boolean;
};

/** 数据库时间戳没有时区后缀，统一按 UTC 解析。 */
export function runtimeTimeMs(value: string): number {
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

/** 超过空闲时长、没有写权限的 ready runtime；最久未活动的排在最前（LRU）。 */
export function idleRuntimes(runtimes: readonly RuntimeCandidate[], nowMs: number, idleTimeoutMs: number): RuntimeCandidate[] {
  return runtimes
    .filter(runtime => runtime.status === 'ready' && !runtime.writeAuthority && nowMs - runtimeTimeMs(runtime.lastActivityAt) >= idleTimeoutMs)
    .sort((left, right) => runtimeTimeMs(left.lastActivityAt) - runtimeTimeMs(right.lastActivityAt));
}

/**
 * 为等待中的 Generation 腾一个槽位时该停谁：ready 且没有写权限的 runtime 里最久未活动的那个。
 * 空闲的优先（LRU 本身就会先挑到它们）；`exclude` 用来跳过正在被收回或刚被接管的 App。
 */
export function evictionVictim(
  runtimes: readonly RuntimeCandidate[],
  exclude: ReadonlySet<string>,
): RuntimeCandidate | null {
  const candidates = runtimes
    .filter(runtime => runtime.status === 'ready' && !runtime.writeAuthority && !exclude.has(runtime.appId))
    .sort((left, right) => runtimeTimeMs(left.lastActivityAt) - runtimeTimeMs(right.lastActivityAt));
  return candidates[0] ?? null;
}

/**
 * cgroup 的匿名内存用量（字节）。`memory.current` / `memory.usage_in_bytes` 会把可回收的
 * page cache 算进来，拿它做配额或监控会杀掉健康的 runtime；这里只认 cgroup v2 的 `anon`
 * 与 cgroup v1 的 `total_rss`。读不到时返回 null，调用方不能把它当 0。
 */
export function anonymousMemoryBytes(memoryStat: string): number | null {
  for (const line of memoryStat.split('\n')) {
    const [name, raw] = line.trim().split(/\s+/);
    if (name !== 'anon' && name !== 'total_rss') continue;
    const bytes = Number(raw);
    if (Number.isSafeInteger(bytes) && bytes >= 0) return bytes;
  }
  return null;
}

/** 排队位置（1 开始）；不属于这个队列返回 null。 */
export function queuePosition(waiting: readonly { appId: string }[], appId: string): number | null {
  const index = waiting.findIndex(item => item.appId === appId);
  return index < 0 ? null : index + 1;
}
