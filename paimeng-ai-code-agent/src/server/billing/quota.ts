import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditGrants, creditQuotaIssues, users } from '@/server/infra/schema';
import {
  monthlyQuotaCredits, insufficientCreditsCode, insufficientCreditsMessage,
  type AccountSummary, type QuotaIssueView, type QuotaPolicySource,
} from '@/shared/billing';
import { accountSnapshot, availableCredits, lockAccounts, recordGrantTx } from './ledger';
import { naiveTime, periodOf, periodRange } from './period';
import { quotaFactsOfPeriod } from './quota-facts';
import { resolveQuotaPolicy } from './quota-policy';

/**
 * 月度配额：每用户每北京自然月一条基础发放事实（`credit_quota_issue`）。
 *
 * 发放金额由策略解析：用户覆盖 > 全局默认 > 代码兜底 500。金额 0 也落 issue、不建零金额 grant。
 * 幂等由 `uk_credit_quota_issue_period (user_id, period)` 与原有 `uk_credit_grant_monthly` 双重保证；
 * 并发调用和重跑都不会多发。触发点仍是注册、读摘要、Admin 入口与 CLI，没有常驻定时器。
 */

/** 单次批量补发的上限：剩下的留到下一次运行，因为幂等所以不需要记录进度。 */
const defaultIssueLimit = 1000;

export type PeriodQuotaResult = { granted: boolean; period: string; issue: QuotaIssueView };

export type MonthlyQuotaRun = {
  period: string;
  dryRun: boolean;
  scanned: number;
  /** 本次新建 issue 的用户数（含 0 配额）。 */
  issued: number;
  /** 本次真正写入 monthly_quota grant 的用户数。 */
  granted: number;
  /** 策略为 0、只写 issue 不写 grant 的用户数。 */
  zero: number;
  /** 本次写入的基础配额合计。 */
  credits: number;
};

function issueViewOf(row: typeof creditQuotaIssues.$inferSelect): QuotaIssueView {
  return {
    id: row.id,
    userId: String(row.userId),
    period: row.period,
    baseCredits: row.baseCredits,
    status: row.status,
    policySource: row.policySource,
    policyVersion: row.policyVersion,
    policyId: row.policyId,
    grantId: row.grantId,
    reason: row.reason,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

/** 用统一口径重算当期配额快照；调用方必须已经锁住该用户的两池。 */
async function rebuildQuotaPool(tx: Transaction, userId: bigint, period: string): Promise<void> {
  const facts = await quotaFactsOfPeriod(tx, userId, period);
  await tx.insert(creditAccounts)
    .values({ userId, pool: 'quota', balance: facts.remainingCredits, updateTime: now() })
    .onConflictDoUpdate({
      target: [creditAccounts.userId, creditAccounts.pool],
      set: { balance: facts.remainingCredits, updateTime: now() },
    });
}

/**
 * 幂等地发放某一账期的配额（默认当前账期）。
 * - 先锁用户两池，再解析策略、写 grant/issue、重算快照，顺序与结算一致。
 * - 旧数据里已有 monthly_quota grant 的账期以旧 grant 为准，不按新策略重新解释。
 * - 已有 granted issue 时直接返回，不重复发放；failed issue 允许重试。
 */
export async function ensurePeriodQuota(userId: string, at: Date = new Date()): Promise<PeriodQuotaResult> {
  const id = BigInt(userId);
  const period = periodOf(at);
  return db().transaction(async tx => {
    // 同一用户同一账期串行化：策略解析、grant 唯一键与 issue 插入之间不留并发窗口。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit_quota_issue:${userId}:${period}`}))`);
    const [existing] = await tx.select().from(creditQuotaIssues)
      .where(and(eq(creditQuotaIssues.userId, id), eq(creditQuotaIssues.period, period)))
      .for('update');
    if (existing?.status === 'granted') return { granted: false, period, issue: issueViewOf(existing) };

    await lockAccounts(tx, id);

    const [legacy] = await tx.select().from(creditGrants)
      .where(and(
        eq(creditGrants.userId, id),
        eq(creditGrants.source, 'monthly_quota'),
        eq(creditGrants.period, period),
      )).limit(1);

    let baseCredits: number;
    let policySource: QuotaPolicySource;
    let policyVersion: number | null;
    let policyId: string | null;
    let grantId = legacy?.id ?? null;
    if (legacy) {
      baseCredits = legacy.credits;
      policySource = 'legacy';
      policyVersion = null;
      policyId = null;
    } else {
      const policy = await resolveQuotaPolicy(tx, id, period);
      baseCredits = policy.credits;
      policySource = policy.source;
      policyVersion = policy.version;
      policyId = policy.policyId;
      if (baseCredits > 0) {
        const { grant } = await recordGrantTx(tx, {
          userId, pool: 'quota', credits: baseCredits, source: 'monthly_quota', period,
        });
        grantId = grant.id;
      }
    }

    const values = {
      baseCredits,
      status: 'granted' as const,
      policySource,
      policyVersion,
      policyId,
      grantId,
      reason: null,
      updateTime: now(),
    };
    const [issue] = existing
      ? await tx.update(creditQuotaIssues).set(values).where(eq(creditQuotaIssues.id, existing.id)).returning()
      : await tx.insert(creditQuotaIssues).values({
        id: randomUUID(),
        userId: id,
        period,
        createTime: now(),
        ...values,
      }).returning();
    await rebuildQuotaPool(tx, id, period);
    return { granted: true, period, issue: issueViewOf(issue) };
  });
}

/**
 * 新 Generation 的准入：先补当前账期的配额，再按「配额池 + 余额池」判定，可用 Credit ≤ 0 就拒绝。
 *
 * 两条边界：
 * - 不看 Overdraft：透支线是运行期熔断线，不是能拿来启动新生成的余额。
 * - 不预扣：准入只读，扣费留到终态结算（已定规则）。因此并发的两笔请求可能都通过准入，
 *   真正的互斥由写权限（同一 App）与运行中熔断负责；余额不足的那一笔会在结算时变成欠款。
 *
 * 调用方负责把它放在任何一个状态写入（generation / authority / execution）之前：被拒的请求
 * 不启动上游模型，也不占住写权限。
 */
export async function assertCanStartGeneration(userId: string, at: Date = new Date()): Promise<void> {
  await ensurePeriodQuota(userId, at);
  const available = await availableCredits(userId);
  if (available.total > 0) return;
  throw new BusinessError(402, insufficientCreditsCode, insufficientCreditsMessage(available));
}

/**
 * 读额度摘要前的确保：先补上当期配额，再返回当前账期的额度快照与有效期。
 * 基础/调整/已用拆解与快照同源，界面不再假设固定 500。
 */
export async function ensureCurrentPeriod(userId: string, at: Date = new Date()): Promise<AccountSummary> {
  const { period } = await ensurePeriodQuota(userId, at);
  const snapshot = await accountSnapshot(userId);
  const facts = await quotaFactsOfPeriod(db(), BigInt(userId), period);
  return {
    ...snapshot,
    // 配额池以事实为准；快照用于核对而不是摘要的真值来源。
    quota: facts.remainingCredits,
    total: facts.remainingCredits + snapshot.balance,
    period,
    quotaExpiresAt: naiveTime(periodRange(period).end),
    quotaBase: facts.baseCredits,
    quotaAdjustments: facts.adjustmentCredits,
    quotaUsed: facts.usedCredits,
    quotaPolicySource: facts.policySource,
    quotaPolicyVersion: facts.policyVersion,
  };
}

/**
 * 批量补发某一账期（默认当前账期）的配额：只挑「这一期还没有 granted issue」的用户。
 * 策略为 0 的用户也会被记一条 issue（不写 grant），所以不会每次都被重复扫描。
 * `dryRun` 只统计待发放人数，不写库；`userIds` 把范围限定到指定的用户（CLI 不传时是全库）。
 */
export async function issueMonthlyQuota(
  options: { at?: Date; dryRun?: boolean; limit?: number; userIds?: readonly string[] } = {},
): Promise<MonthlyQuotaRun> {
  const at = options.at ?? new Date();
  const dryRun = options.dryRun ?? false;
  const period = periodOf(at);
  const limit = options.limit ?? defaultIssueLimit;
  const scope = options.userIds?.map(id => BigInt(id));

  const issued = db().select({ userId: creditQuotaIssues.userId }).from(creditQuotaIssues)
    .where(and(eq(creditQuotaIssues.period, period), eq(creditQuotaIssues.status, 'granted')));
  const conditions = [eq(users.isDelete, 0), notInArray(users.id, issued)];
  if (scope?.length) conditions.push(inArray(users.id, scope));
  const candidates = await db().select({ id: users.id }).from(users)
    .where(and(...conditions))
    .orderBy(asc(users.id))
    .limit(limit);

  const empty = { period, dryRun, scanned: candidates.length, issued: 0, granted: 0, zero: 0, credits: 0 };
  if (dryRun) return empty;
  let issuedCount = 0;
  let granted = 0;
  let zero = 0;
  let credits = 0;
  for (const candidate of candidates) {
    const result = await ensurePeriodQuota(candidate.id.toString(), at);
    if (!result.granted) continue;
    issuedCount += 1;
    credits += result.issue.baseCredits;
    if (result.issue.baseCredits > 0) granted += 1;
    else zero += 1;
  }
  return { ...empty, issued: issuedCount, granted, zero, credits };
}

/** 供 CLI/测试读取当前账期默认标准；策略解析仍以 `resolveQuotaPolicy` 为准。 */
export const defaultMonthlyQuotaCredits = monthlyQuotaCredits;
