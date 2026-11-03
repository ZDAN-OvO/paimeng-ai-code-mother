import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditCharges, users } from '@/server/infra/schema';
import { idSchema } from '@/shared/contracts';
import {
  type AdminIssueReceipt, type AdminIssueRequest, type AdminUserUsage, type ChargeReversalReceipt, type ChargeStatus,
  type IssueFailure, maxIssueUsers,
} from '@/shared/billing';
import {
  accountSnapshot, chargesOf, effectiveCreditsOf, entriesOfCharge, insertLedgerTx, reverseCharge,
} from './ledger';
import { ensureExpiryTx, lockBalance, rebuildBalanceTx } from './expiry';
import { naiveTime, periodOf, periodRange } from './period';
import { adminUserCreditDetail } from './overview';
import { finishOperation, startOperation } from './operations';

export type AdminIssueInput = AdminIssueRequest & { operatorId: string };

/**
 * 管理员发放：限时积分落在当前账期（月底过期），长期积分不过期。都只是账本里的一行。
 *
 * 单人发放的凭据就是那一行；批量才写一条 `credit_operation` 摘要。
 * `requestId` 是幂等键：重试同一请求不会重复发钱。
 */
export async function issueCredits(input: AdminIssueInput): Promise<AdminIssueReceipt> {
  const userIds = [...new Set(input.userId ? [idSchema.parse(input.userId)] : input.userIds ?? [])];
  if (!userIds.length) throw new BusinessError(400, 40000, '请选择要发放的用户');
  if (userIds.length > maxIssueUsers) throw new BusinessError(400, 40000, `一次最多发放给 ${maxIssueUsers} 个用户`);

  const at = new Date();
  const period = periodOf(at);
  const expiresAt = input.kind === 'limited' ? naiveTime(periodRange(period).end) : null;
  const operationId = userIds.length > 1
    ? await startOperation({
      kind: 'issue_users',
      period: input.kind === 'limited' ? period : null,
      operatorId: input.operatorId,
      targetCount: userIds.length,
    })
    : null;

  let created = 0;
  let credits = 0;
  const failures: IssueFailure[] = [];
  const errors: unknown[] = [];
  for (const userId of userIds) {
    try {
      const id = BigInt(userId);
      // 每次重算都要看到同一个人的最新余额与过期行；单人一个事务，失败不拖累其他人。
      await db().transaction(async tx => {
        const [user] = await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.id, id), eq(users.isDelete, 0))).limit(1);
        if (!user) throw new BusinessError(404, 40400, '用户不存在');
        await lockBalance(tx, id);
        await ensureExpiryTx(tx, userId, at);
        const row = await insertLedgerTx(tx, {
          userId: id,
          kind: input.kind === 'limited' ? 'quota' : 'grant',
          origin: 'manual',
          credits: input.credits,
          period: input.kind === 'limited' ? period : null,
          expiresAt,
          reason: input.reason,
          operatorId: BigInt(input.operatorId),
          requestId: input.requestId,
          createTime: now(),
        });
        // 唯一键冲突说明这次请求已经发过（重放），不算失败也不算新增。
        if (!row) return;
        created += 1;
        credits += row.credits;
        await rebuildBalanceTx(tx, userId, at);
      });
    } catch (error) {
      if (userIds.length === 1) throw error;
      errors.push(error);
      failures.push({ userId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (operationId) {
    await finishOperation(operationId, {
      issuedCount: created,
      skippedCount: userIds.length - created - failures.length,
      failedCount: failures.length,
      credits,
      failures,
    });
  }
  return { operationId, created, credits, failures };
}

/**
 * 后台查账（92）：一个用户的积分快照 + 最近账单，成本与估算质量一并返回。
 * 金额一律给有效金额，成本用 `costUsd` 的 null 表达「未知」。
 */
export async function userUsage(input: { userId: string; limit: number }): Promise<AdminUserUsage> {
  const userId = idSchema.parse(input.userId);
  const [user] = await db().select({ id: users.id }).from(users)
    .where(and(eq(users.id, BigInt(userId)), eq(users.isDelete, 0))).limit(1);
  if (!user) throw new BusinessError(404, 40400, '用户不存在');

  const [account, charges, credit] = await Promise.all([
    accountSnapshot(userId),
    chargesOf({ userId, limit: input.limit, includeCost: true }),
    adminUserCreditDetail(userId),
  ]);
  return {
    userId,
    account,
    credit,
    charges,
    estimatedRatio: ratioOf(charges.filter(charge => charge.estimated).length, charges.length),
    unpricedRatio: ratioOf(charges.filter(charge => charge.unpriced).length, charges.length),
  };
}

/** 按账单条数的比例，保留 4 位小数：界面乘 100 就是百分比。 */
function ratioOf(matched: number, total: number): number {
  return total === 0 ? 0 : Math.round(matched / total * 10_000) / 10_000;
}

/**
 * 管理员整笔冲正：复用结算侧的 `reverseCharge`，共享同一份幂等保护。
 * 三种结果必须能区分：账单不存在 404；已经整笔冲正 `reversed:false`；没有分录可退 409。
 */
export async function reverseChargeByAdmin(input: {
  chargeId: string;
  reason: string;
  operatorId: string;
}): Promise<ChargeReversalReceipt> {
  const [charge] = await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
    .where(eq(creditCharges.generationId, input.chargeId)).limit(1);
  if (!charge) throw new BusinessError(404, 40400, '账单不存在');

  const result = await reverseCharge(input.chargeId, { reason: input.reason, operatorId: input.operatorId });
  if (!result.reversed && (await entriesOfCharge(input.chargeId)).length === 0) {
    throw new BusinessError(409, 40900, '这笔账单没有可冲正的金额（待处理或 0 积分），无需冲正');
  }
  const [projection] = await db().select({ status: creditCharges.status }).from(creditCharges)
    .where(eq(creditCharges.generationId, input.chargeId)).limit(1);
  return {
    reversed: result.reversed,
    entries: result.entries,
    status: projection.status as ChargeStatus,
    effectiveCredits: await effectiveCreditsOf(input.chargeId),
  };
}
