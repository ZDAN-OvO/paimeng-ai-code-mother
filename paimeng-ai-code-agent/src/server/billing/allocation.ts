import type { CreditEntryKind, CreditEntryOrigin } from '@/shared/billing';
import { naiveTime, parseNaiveTime, periodOf, periodRange } from './period';

/**
 * 账本算术（纯函数）：把一个用户的流水折叠成「每个账期还剩多少」，
 * 再按到期顺序分配扣减。数据库读写在 `expiry.ts` / `ledger.ts`，这里不做 IO。
 *
 * 口径只有一条：**可用额 = 所有条目之和**，过期的账期贡献 0。
 * 「限时 / 长期」不是两个池，而是同一个和按 `expires_at` 切开的两段。
 */

export type LedgerLike = {
  id: bigint | number | string;
  kind: CreditEntryKind;
  origin: CreditEntryOrigin;
  credits: number;
  period: string | null;
  expiresAt: string | null;
  createTime: string;
};

export type PeriodFacts = {
  period: string;
  expiresAt: string;
  issued: number;
  consumed: number;
  expired: number;
  /** 是否已经写过账期边界的过期行（`origin='expiry'`）。 */
  swept: boolean;
  /** 还没被过期清零的剩余；可能是 0。 */
  remaining: number;
};

export type AllocationSlice = { period: string; expiresAt: string; credits: number };

export type Split = {
  available: number;
  limited: number;
  lasting: number;
  nextExpiryAt: string | null;
};

function compareTime(left: string, right: string): number {
  return parseNaiveTime(left).getTime() - parseNaiveTime(right).getTime();
}

/** 按账期折叠：规则/手动发放算 issued，消费与退回算 consumed，过期行算 expired。 */
export function periodsOf(rows: readonly LedgerLike[], at: Date = new Date()): Map<string, PeriodFacts> {
  const periods = new Map<string, PeriodFacts>();
  const now = naiveTime(at);
  for (const row of rows) {
    if (row.period === null) continue;
    const current = periods.get(row.period) ?? {
      period: row.period,
      expiresAt: row.expiresAt ?? naiveTime(periodRange(row.period).end),
      issued: 0,
      consumed: 0,
      expired: 0,
      swept: false,
      remaining: 0,
    };
    if (row.kind === 'quota') current.issued += row.credits;
    else if (row.kind === 'consume' || row.kind === 'refund') current.consumed -= row.credits;
    else if (row.kind === 'expire') {
      current.expired -= row.credits;
      if (row.origin === 'expiry') current.swept = true;
    }
    periods.set(row.period, current);
  }
  for (const facts of periods.values()) {
    facts.remaining = facts.issued - facts.consumed - facts.expired;
    // 已经越过到期时刻、又还没写过期行的账期，按 0 计入可用额（与 `pendingExpiry` 的口径一致）。
    if (compareTime(facts.expiresAt, now) <= 0) facts.remaining = Math.max(0, facts.remaining);
  }
  return periods;
}

/**
 * 还没写过期行、但已经到期的余量：列表页用它修正「扫描没跑」时的可用额。
 * 只统计已结束账期，且没有 `origin='expiry'` 的过期行。
 */
export function pendingExpiryOf(rows: readonly LedgerLike[], at: Date = new Date()): { period: string; remainder: number }[] {
  const currentPeriod = periodOf(at);
  return [...periodsOf(rows, at).values()]
    .filter(facts => facts.period < currentPeriod && !facts.swept && facts.remaining > 0)
    .map(facts => ({ period: facts.period, remainder: facts.remaining }));
}

/**
 * 可用额、限时、长期与下个到期时刻。
 * 传入的流水应包含该用户**全部**条目；未写过期行的账期在这里已经按 0 处理。
 */
export function splitOf(rows: readonly LedgerLike[], at: Date = new Date()): Split {
  const now = naiveTime(at);
  const periods = periodsOf(rows, at);
  const pending = pendingExpiryOf(rows, at);
  const available = rows.reduce((sum, row) => sum + row.credits, 0)
    - pending.reduce((sum, item) => sum + item.remainder, 0);
  let limited = 0;
  let nextExpiryAt: string | null = null;
  for (const facts of periods.values()) {
    if (compareTime(facts.expiresAt, now) <= 0) continue;
    if (facts.remaining <= 0) continue;
    limited += facts.remaining;
    if (nextExpiryAt === null || compareTime(facts.expiresAt, nextExpiryAt) < 0) nextExpiryAt = facts.expiresAt;
  }
  return { available, limited, lasting: available - limited, nextExpiryAt };
}

/**
 * 按到期顺序分配一笔扣减：先扣最早到期的账期，扣完再落到长期积分。
 * 返回的 `slices` 每个账期一段，`lasting` 是溢出到长期积分的金额。
 */
export function allocate(rows: readonly LedgerLike[], credits: number, at: Date = new Date()): {
  slices: AllocationSlice[];
  lasting: number;
} {
  const now = naiveTime(at);
  const candidates = [...periodsOf(rows, at).values()]
    .filter(facts => facts.remaining > 0 && compareTime(facts.expiresAt, now) > 0)
    .sort((left, right) => compareTime(left.expiresAt, right.expiresAt) || left.period.localeCompare(right.period));
  let need = credits;
  const slices: AllocationSlice[] = [];
  for (const facts of candidates) {
    if (need <= 0) break;
    const take = Math.min(need, facts.remaining);
    slices.push({ period: facts.period, expiresAt: facts.expiresAt, credits: take });
    need -= take;
  }
  return { slices, lasting: Math.max(0, need) };
}

/** 测试与对账用：直接从流水读出某个账期的剩余（含未写出的过期）。 */
export function remainderOfPeriod(rows: readonly LedgerLike[], period: string): number {
  return periodsOf(rows).get(period)?.remaining ?? 0;
}
