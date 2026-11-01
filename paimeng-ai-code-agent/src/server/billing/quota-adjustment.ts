import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditQuotaAdjustments, users } from '@/server/infra/schema';
import {
  maxMonthlyQuotaCredits, maxQuotaAdjustmentCredits,
  type QuotaAdjustmentReceipt, type QuotaAdjustmentRequest, type QuotaAdjustmentView,
} from '@/shared/billing';
import { lockAccounts } from './ledger';
import { naiveTime, periodOf, periodRange } from './period';
import { quotaFactsOfPeriod } from './quota-facts';
import { ensurePeriodQuota } from './quota';

/**
 * 单用户当月配额调整：只追加一条有符号差额，然后按统一口径重算配额快照。
 *
 * - 只允许当前北京账期；已结束月份只读，未来账期不能提前调整。
 * - 先确保当月基础发放，再在同一事务里锁两池、算差额、写调整、重算快照。
 * - 扣回不得超过当前有效剩余；目标剩余由服务端在锁内计算，不接受客户端自己算好的差额。
 * - 同 requestId 同载荷返回原回执；同键异载荷 409。理由与操作人写进调整行。
 */

const maxAdjustedQuota = maxMonthlyQuotaCredits + maxQuotaAdjustmentCredits;

function fingerprintOf(input: { period: string; mode: string; amount: number }): string {
  return createHash('sha256')
    .update(JSON.stringify({ period: input.period, mode: input.mode, amount: input.amount }))
    .digest('hex');
}

function viewOf(row: typeof creditQuotaAdjustments.$inferSelect): QuotaAdjustmentView {
  return {
    id: row.id,
    userId: String(row.userId),
    period: row.period,
    mode: row.mode,
    credits: row.credits,
    reason: row.reason,
    operatorId: String(row.operatorId),
    requestId: row.requestId,
    beforeCredits: row.beforeCredits,
    afterCredits: row.afterCredits,
    createTime: row.createTime,
  };
}

export async function adjustQuota(input: QuotaAdjustmentRequest, operatorId: string): Promise<QuotaAdjustmentReceipt> {
  const userId = BigInt(input.userId);
  const period = periodOf(new Date());
  if (input.period && input.period !== period) {
    throw new BusinessError(400, 40000, input.period < period
      ? '已结束月份只读；如需补当前月请显式给当前账期追加'
      : '不能提前调整未来账期；未来标准请走配额策略');
  }
  const [user] = await db().select({ id: users.id }).from(users)
    .where(and(eq(users.id, userId), eq(users.isDelete, 0))).limit(1);
  if (!user) throw new BusinessError(404, 40400, '用户不存在');

  // 调整前先确保基础月度发放；这一步自己会锁两池并重算快照。
  await ensurePeriodQuota(input.userId);

  const fingerprint = fingerprintOf({ period, mode: input.mode, amount: input.amount });
  return db().transaction(async tx => {
    // 同一用户的调整串行化；结算也用同一对账户锁，两者不会交错读到旧值。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit_quota_adjust:${input.userId}`}))`);
    await lockAccounts(tx, userId);

    const [existing] = await tx.select().from(creditQuotaAdjustments)
      .where(and(
        eq(creditQuotaAdjustments.userId, userId),
        eq(creditQuotaAdjustments.requestId, input.requestId),
      )).limit(1);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new BusinessError(409, 40900, '同一 requestId 已用于另一笔调整；请换一个新的请求键');
      }
      return {
        created: false,
        adjustment: viewOf(existing),
        period: existing.period,
        beforeCredits: existing.beforeCredits,
        afterCredits: existing.afterCredits,
        expiresAt: naiveTime(periodRange(existing.period).end),
      };
    }

    const before = await quotaFactsOfPeriod(tx, userId, period);
    const delta = input.mode === 'increase'
      ? input.amount
      : input.mode === 'decrease'
        ? -input.amount
        : input.amount - before.remainingCredits;
    if (delta === 0) throw new BusinessError(400, 40000, '调整后剩余与当前相同，无需调整');
    const after = before.remainingCredits + delta;
    if (after < 0) throw new BusinessError(409, 40900, `扣回后配额会变成 ${after}，不能超过当前有效剩余 ${before.remainingCredits}`);
    if (after > maxAdjustedQuota) {
      throw new BusinessError(400, 40000, `调整后剩余不能超过 ${maxAdjustedQuota} Credit`);
    }

    const createTime = now();
    const [row] = await tx.insert(creditQuotaAdjustments).values({
      id: randomUUID(),
      userId,
      period,
      mode: input.mode,
      credits: delta,
      reason: input.reason,
      operatorId: BigInt(operatorId),
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      beforeCredits: before.remainingCredits,
      afterCredits: after,
      createTime,
    }).returning();

    // 以调整后的事实重算一次，避免“before + delta”与并发扣减/其它写入脱节。
    const facts = await quotaFactsOfPeriod(tx, userId, period);
    await tx.insert(creditAccounts)
      .values({ userId, pool: 'quota', balance: facts.remainingCredits, updateTime: createTime })
      .onConflictDoUpdate({
        target: [creditAccounts.userId, creditAccounts.pool],
        set: { balance: facts.remainingCredits, updateTime: createTime },
      });
    return {
      created: true,
      adjustment: viewOf(row),
      period,
      beforeCredits: before.remainingCredits,
      afterCredits: facts.remainingCredits,
      expiresAt: naiveTime(periodRange(period).end),
    };
  });
}
