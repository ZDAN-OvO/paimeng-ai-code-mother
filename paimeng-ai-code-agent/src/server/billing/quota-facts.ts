import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Transaction } from '@/server/infra/db';
import { creditGrants, creditQuotaIssues } from '@/server/infra/schema';
import type { QuotaPolicySource } from '@/shared/billing';
import { naiveTime, periodRange } from './period';

/**
 * 当期配额事实的统一口径：
 * `当前有效配额 = max(0, 当期基础已发 + 当期调整净额 - 当期配额消费净额)`。
 *
 * 本人摘要、Admin 总览/详情、结算分池、audit/rebuild、CLI 都从这里取数，避免各自再写一份算法。
 * C2 还没有调整表，调整净额固定为 0；C3 接入 adjustment 后只改这一个文件。
 */
export type QuotaFacts = {
  baseCredits: number;
  adjustmentCredits: number;
  usedCredits: number;
  remainingCredits: number;
  issueStatus: 'pending' | 'granted' | 'failed';
  policySource: QuotaPolicySource;
  policyVersion: number | null;
  issue: typeof creditQuotaIssues.$inferSelect | null;
};

type Run = ReturnType<typeof db> | Transaction;

export async function quotaFactsOfPeriod(run: Run, userId: bigint, period: string): Promise<QuotaFacts> {
  const [issue] = await run.select().from(creditQuotaIssues)
    .where(and(eq(creditQuotaIssues.userId, userId), eq(creditQuotaIssues.period, period)))
    .limit(1);
  const [legacy] = await run.select({ credits: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(
      eq(creditGrants.userId, userId),
      eq(creditGrants.source, 'monthly_quota'),
      eq(creditGrants.period, period),
    ));
  const { start, end } = periodRange(period);
  const used = await run.execute(sql`select coalesce(sum(entry.credits), 0) as credits
    from credit_entry entry
    join credit_charge charge on charge.generation_id = entry.charge_id
    where entry.pool = 'quota'
      and charge.user_id = ${userId}
      and charge.create_time >= ${naiveTime(start)}
      and charge.create_time < ${naiveTime(end)}`);
  const usedCredits = Number(used.rows[0]?.credits ?? 0);
  // 迁移回填之前的历史 grant 仍算事实；已有 granted issue 时以 issue 固定的金额为准，
  // 这样以后改策略不会把已发月份重新解释成新标准。
  const baseCredits = issue?.status === 'granted' ? issue.baseCredits : Number(legacy?.credits ?? 0);
  const adjustmentCredits = 0;
  return {
    baseCredits,
    adjustmentCredits,
    usedCredits,
    remainingCredits: Math.max(0, baseCredits + adjustmentCredits - usedCredits),
    issueStatus: issue?.status ?? (baseCredits > 0 ? 'granted' : 'pending'),
    policySource: issue?.policySource ?? (baseCredits > 0 ? 'legacy' : 'fallback'),
    policyVersion: issue?.policyVersion ?? null,
    issue: issue ?? null,
  };
}
