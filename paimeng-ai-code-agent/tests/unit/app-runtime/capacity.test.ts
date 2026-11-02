import { describe, expect, it } from 'vitest';
import {
  anonymousMemoryBytes, evictionVictim, idleRuntimes, queuePosition, type RuntimeCandidate,
} from '@/server/app-runtime/capacity';
import { getConfig } from '@/server/infra/config';

const minute = 60_000;
const at = Date.parse('2026-11-03T12:00:00.000Z');
const naive = (msAgo: number) => new Date(at - msAgo).toISOString().slice(0, 23).replace('T', ' ');

const runtime = (appId: string, msAgo: number, extra: Partial<RuntimeCandidate> = {}): RuntimeCandidate => ({
  appId, status: 'ready', lastActivityAt: naive(msAgo), writeAuthority: false, ...extra,
});

describe('运行时容量策略', () => {
  it('空闲回收只挑超过空闲时长、没有写权限的 ready runtime，并按最久未活动排序', () => {
    const runtimes = [
      runtime('busy', 20 * minute, { writeAuthority: true }),
      runtime('recent', 2 * minute),
      runtime('oldest', 40 * minute),
      runtime('old', 16 * minute),
      runtime('starting', 30 * minute, { status: 'starting' }),
    ];
    expect(idleRuntimes(runtimes, at, 15 * minute).map(item => item.appId)).toEqual(['oldest', 'old']);
  });

  it('LRU 驱逐跳过持有写权限的 App；全部受保护时没有牺牲者', () => {
    const runtimes = [
      runtime('busy', 60 * minute, { writeAuthority: true }),
      runtime('recent', 1 * minute),
      runtime('older', 10 * minute),
    ];
    expect(evictionVictim(runtimes, new Set())?.appId).toBe('older');
    expect(evictionVictim(runtimes, new Set(['older']))?.appId).toBe('recent');
    expect(evictionVictim([runtime('busy', 99 * minute, { writeAuthority: true })], new Set())).toBeNull();
    expect(evictionVictim([runtime('starting', 99 * minute, { status: 'starting' })], new Set())).toBeNull();
  });

  it('容量统计取 cgroup 匿名内存，不把可回收 page cache 当占用', () => {
    // cgroup v2：anon 是匿名内存，file 是页缓存，total 会把两者相加。
    expect(anonymousMemoryBytes('anon 10485760\nfile 734003200\ninactive_file 524288000\n')).toBe(10485760);
    // cgroup v1 的等价项是 total_rss，cache 同样是可回收页缓存。
    expect(anonymousMemoryBytes('cache 104857600\ntotal_rss 5242880\n')).toBe(5242880);
    expect(anonymousMemoryBytes('file 123\n')).toBeNull();
    expect(anonymousMemoryBytes('')).toBeNull();
  });

  it('默认容量：全机 3 个 runtime、连续 15 分钟无活动回收', () => {
    const previous = { max: process.env.RUNTIME_MAX_SLOTS, idle: process.env.RUNTIME_IDLE_TIMEOUT_MS };
    delete process.env.RUNTIME_MAX_SLOTS;
    delete process.env.RUNTIME_IDLE_TIMEOUT_MS;
    try {
      expect(getConfig().appRuntime).toMatchObject({ maxSlots: 3, idleTimeoutMs: 900_000 });
    } finally {
      if (previous.max === undefined) delete process.env.RUNTIME_MAX_SLOTS;
      else process.env.RUNTIME_MAX_SLOTS = previous.max;
      if (previous.idle === undefined) delete process.env.RUNTIME_IDLE_TIMEOUT_MS;
      else process.env.RUNTIME_IDLE_TIMEOUT_MS = previous.idle;
    }
  });

  it('排队位置按入队顺序编号，不在队列里返回 null', () => {
    const queue = [{ appId: 'a' }, { appId: 'b' }, { appId: 'c' }];
    expect(queuePosition(queue, 'a')).toBe(1);
    expect(queuePosition(queue, 'c')).toBe(3);
    expect(queuePosition(queue, 'missing')).toBeNull();
  });
});
