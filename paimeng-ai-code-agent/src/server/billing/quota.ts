import 'server-only';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditLedger, users } from '@/server/infra/schema';
import {
  insufficientCreditsCode, insufficientCreditsMessage, monthlyQuotaCredits,
  type AccountSummary, type CreditLedgerEntryView, type EffectiveQuotaPolicy, type QuotaPolicySource,
} from '@/shared/billing';
import { accountSnapshot, insertLedgerTx, ledgerEntryView } from './ledger';
import { ensureExpiryTx, lockBalance, rebuildBalanceTx } from './expiry';
import { naiveTime, periodOf, periodRange } from './period';
import { resolveQuotaPolicy } from './quota-policy';
import { finishOperation, startOperation } from './operations';

/**
 * 每月限时积分：每用户每北京自然月一条 `origin='rule'` 的账本行。
 *
 * 金额由策略解析（用户覆盖 > 全局默认 > 代码兜底 500）；金额 0 也写行（`credits=0`），
 * 所以「待发」= 本期没有规则行，不看余额、不看金额。幂等由部分唯一索引保证。
 * 触发点仍是注册、读摘要、Admin 入口与 CLI，没有常驻定时器。
 */

/** 单次批量补发的上限：剩下的留到下一次运行，因为幂等所以不需要记录进度。 */
const defaultIssueLimit = 1000;

export type PeriodQuotaResult = {
  granted: boolean;
  period: string;
  credits: number;
  policySource: QuotaPolicySource;
  policyVersion: number | null;
  entry: CreditLedgerEntryView;
};

export type MonthlyQuotaRun = {
  period: string;
  dryRun: boolean;
  scanned: number;
  /** 本次新建规则行的用户数（含 0 积分）。 */
  issued: number;
  /** 本次真正写入正数积分的用户数。 */
  granted: number;
  /** 规则为 0、只写回执行的用户数。 */
  zero: number;
  /** 本次写入的限时积分合计。 */
  credits: number;
  operationId: string | null;
  failures: { userId: string; reason: string }[];
};

function reasonOf(policy: EffectiveQuotaPolicy): string {
  const source = policy.source === 'user' ? '用户覆盖' : policy.source === 'global' ? '全局默认' : policy.source === 'legacy' ? '历史发放' : '系统默认';
  return `每月规则：${source}${policy.version === null ? '' : ` v${policy.version}`}`;
}

/** 读当期规则行（0 也算已发）。 */
export async function ruleEntryOf(
  run: ReturnType<typeof db> | Transaction, userId: bigint, period: string,
): Promise<typeof creditLedger.$inferSelect | null> {
  const [row] = await run.select().from(creditLedger)
    .where(and(
      eq(creditLedger.userId, userId),
      eq(creditLedger.kind, 'quota'),
      eq(creditLedger.origin, 'rule'),
      eq(creditLedger.period, period),
    )).limit(1);
  return row ?? null;
}

/**
 * 幂等地发放某一账期的限时积分（默认当前账期）。
 * 顺序：锁用户 → 补过期 → 查规则行 → 解析策略 → 写行 → 重算快照。
 */
export async function ensurePeriodQuota(userId: string, at: Date = new Date()): Promise<PeriodQuotaResult> {
  const id = BigInt(userId);
  const period = periodOf(at);
  return db().transaction(async tx => {
    const [active] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, id), eq(users.isDelete, 0))).limit(1);
    if (!active) throw new BusinessError(404, 40400, '用户不存在');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit_ledger:rule:${userId}:${period}`}))`);
    await lockBalance(tx, id);
    await ensureExpiryTx(tx, userId, at);

    const existing = await ruleEntryOf(tx, id, period);
    if (existing) {
      const policy = await resolveQuotaPolicy(tx, id, period);
      return {
        granted: false,
        period,
        credits: existing.credits,
        policySource: policy.source,
        policyVersion: policy.version,
        entry: ledgerEntryView(existing),
      };
    }

    const policy = await resolveQuotaPolicy(tx, id, period);
    const expiresAt = naiveTime(periodRange(period).end);
    const inserted = await insertLedgerTx(tx, {
      userId: id,
      kind: 'quota',
      origin: 'rule',
      credits: policy.credits,
      period,
      expiresAt,
      reason: reasonOf(policy),
      createTime: now(),
    });
    if (!inserted) {
      // 并发插入撞上唯一键：读回另一条，当作已经发过。
      const row = await ruleEntryOf(tx, id, period);
      if (!row) throw new BusinessError(409, 40900, '本期规则发放已存在，但无法定位对应条目');
      return {
        granted: false, period, credits: row.credits, policySource: policy.source,
        policyVersion: policy.version, entry: ledgerEntryView(row),
      };
    }
    await rebuildBalanceTx(tx, userId, at);
    return {
      granted: true,
      period,
      credits: inserted.credits,
      policySource: policy.source,
      policyVersion: policy.version,
      entry: ledgerEntryView(inserted),
    };
  });
}

/**
 * 新 Generation 的准入：先补当前账期与过期，再按账本可用额判定，≤ 0 就拒绝。
 * 不看 Overdraft：透支线是运行期熔断线，不是能拿来启动新生成的余额。
 */
export async function assertCanStartGeneration(userId: string, at: Date = new Date()): Promise<void> {
  const summary = await ensureCurrentPeriod(userId, at);
  if (summary.available > 0) return;
  throw new BusinessError(402, insufficientCreditsCode, insufficientCreditsMessage(summary));
}

/** 读额度摘要前的确保：补当期规则与过期，再返回一个数加两种口径。 */
export async function ensureCurrentPeriod(userId: string, at: Date = new Date()): Promise<AccountSummary> {
  const { period } = await ensurePeriodQuota(userId, at);
  const snapshot = await accountSnapshot(userId, at);
  return { ...snapshot, period };
}

/**
 * 批量补发某一账期（默认当前账期）：只挑「这一期还没有规则行」的用户。
 * 规则为 0 的用户也会被记一行，所以不会每次都被重复扫描。`dryRun` 只统计人数，不写库。
 */
export async function issuePendingQuota(
  options: { at?: Date; dryRun?: boolean; limit?: number; userIds?: readonly string[]; operatorId?: string } = {},
): Promise<MonthlyQuotaRun> {
  const at = options.at ?? new Date();
  const dryRun = options.dryRun ?? false;
  const period = periodOf(at);
  const limit = options.limit ?? defaultIssueLimit;
  const scope = options.userIds?.map(id => BigInt(id));

  const issued = db().select({ userId: creditLedger.userId }).from(creditLedger)
    .where(and(
      eq(creditLedger.period, period),
      eq(creditLedger.kind, 'quota'),
      eq(creditLedger.origin, 'rule'),
    ));
  const conditions = [eq(users.isDelete, 0), notInArray(users.id, issued)];
  if (scope?.length) conditions.push(inArray(users.id, scope));
  const candidates = await db().select({ id: users.id }).from(users)
    .where(and(...conditions))
    .orderBy(asc(users.id))
    .limit(limit);

  const empty: MonthlyQuotaRun = {
    period, dryRun, scanned: candidates.length, issued: 0, granted: 0, zero: 0, credits: 0,
    operationId: null, failures: [],
  };
  if (dryRun) return empty;

  const operationId = await startOperation({
    kind: 'issue_pending',
    period,
    operatorId: options.operatorId ?? null,
    targetCount: candidates.length,
  });

  let issuedCount = 0;
  let granted = 0;
  let zero = 0;
  let credits = 0;
  const failures: { userId: string; reason: string }[] = [];
  for (const candidate of candidates) {
    try {
      const result = await ensurePeriodQuota(candidate.id.toString(), at);
      if (!result.granted) continue;
      issuedCount += 1;
      credits += result.credits;
      if (result.credits > 0) granted += 1;
      else zero += 1;
    } catch (error) {
      failures.push({ userId: candidate.id.toString(), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  await finishOperation(operationId, {
    issuedCount,
    skippedCount: candidates.length - issuedCount - failures.length,
    failedCount: failures.length,
    credits,
    failures,
  });
  return { ...empty, issued: issuedCount, granted, zero, credits, operationId, failures };
}

/** 供 CLI/测试读取当前账期默认标准；策略解析仍以 `resolveQuotaPolicy` 为准。 */
export const defaultMonthlyQuotaCredits = monthlyQuotaCredits;
