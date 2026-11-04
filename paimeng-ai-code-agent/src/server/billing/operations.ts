import 'server-only';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { creditOperations, users } from '@/server/infra/schema';
import type { CreditOperationKind, CreditOperationView } from '@/shared/billing';

/**
 * 操作日志：只记批量发放与过期扫描的摘要，不记单笔。
 * 金额与人数永远可以按 `request_id` 从 `credit_ledger` 重算，所以它是可重建的摘要，不是第二份真值。
 */

const maxDetail = 200;

export async function startOperation(input: {
  kind: CreditOperationKind;
  period: string | null;
  operatorId: string | null;
  targetCount: number;
  requestId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(creditOperations)
    .values({
      id,
      kind: input.kind,
      requestId: input.requestId ?? randomUUID(),
      period: input.period,
      operatorId: input.operatorId === null ? null : BigInt(input.operatorId),
      targetCount: input.targetCount,
      issuedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      credits: 0,
      status: 'running',
      detail: [],
      createTime: now(),
    });
  return id;
}

export async function finishOperation(
  id: string,
  input: {
    issuedCount: number;
    skippedCount: number;
    failedCount: number;
    credits: number;
    failures: { userId: string; reason: string }[];
  },
): Promise<void> {
  const status =
    input.failedCount === 0 ? 'completed' : input.issuedCount > 0 ? 'partial' : 'failed';
  await db()
    .update(creditOperations)
    .set({
      issuedCount: input.issuedCount,
      skippedCount: input.skippedCount,
      failedCount: input.failedCount,
      credits: input.credits,
      status,
      detail: input.failures.slice(0, maxDetail),
      finishTime: now(),
    })
    .where(eq(creditOperations.id, id));
}

/** 最近的操作记录；操作人姓名随行带出，已删除的用户显示 null。 */
export async function listOperations(limit: number): Promise<CreditOperationView[]> {
  const rows = await db()
    .select({
      operation: creditOperations,
      operatorName: users.userName,
      operatorAccount: users.userAccount,
    })
    .from(creditOperations)
    .leftJoin(users, eq(users.id, creditOperations.operatorId))
    .orderBy(desc(creditOperations.createTime))
    .limit(limit);
  return rows.map(({ operation, operatorName, operatorAccount }) => ({
    id: operation.id,
    kind: operation.kind,
    requestId: operation.requestId,
    period: operation.period,
    operatorId: operation.operatorId === null ? null : String(operation.operatorId),
    operatorName: operatorName ?? operatorAccount ?? null,
    targetCount: operation.targetCount,
    issuedCount: operation.issuedCount,
    skippedCount: operation.skippedCount,
    failedCount: operation.failedCount,
    credits: operation.credits,
    status: operation.status,
    detail: operation.detail ?? [],
    createTime: operation.createTime,
    finishTime: operation.finishTime,
  }));
}
