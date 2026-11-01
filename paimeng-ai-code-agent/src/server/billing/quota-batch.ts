import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import {
  creditGrants, creditQuotaBatchItems, creditQuotaBatches, creditQuotaIssues, users,
} from '@/server/infra/schema';
import {
  maxQuotaBatchChunk, maxQuotaBatchUsers,
  type QuotaBatchExecuteRequest, type QuotaBatchItemStatus, type QuotaBatchItemView, type QuotaBatchPreviewRequest,
  type QuotaBatchScope, type QuotaBatchStatus, type QuotaBatchView, type QuotaPolicySource,
} from '@/shared/billing';
import { periodOf } from './period';
import { resolveQuotaPolicy } from './quota-policy';
import { ensurePeriodQuota } from './quota';

/**
 * Admin 月度批量发放：预览固定账期、范围与逐用户策略快照，确认后按批次执行。
 *
 * - 预览只写批次元数据，不发钱；已发用户显示为 skipped。
 * - 执行前重新解析每个待发用户的策略并与预览快照比对；账期或策略变化直接 superseded，不写账。
 * - 每次最多处理 `limit` 个待发项，剩余保持 running；部分失败逐项记录，重试只重跑 failed。
 * - 幂等仍由 `ensurePeriodQuota` 的 issue/grant 唯一键兜底；并发懒发放只会让 item 变成 skipped。
 */

type BatchRow = typeof creditQuotaBatches.$inferSelect;
type ItemRow = typeof creditQuotaBatchItems.$inferSelect;

const itemViewLimit = 200;

function fingerprintOf(period: string, items: { userId: string; baseCredits: number; source: string; version: number | null }[]): string {
  const payload = items
    .slice()
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map(item => `${item.userId}:${item.baseCredits}:${item.source}:${item.version ?? ''}`)
    .join('|');
  return createHash('sha256').update(`${period}|${payload}`).digest('hex');
}

function batchViewOf(row: BatchRow, options: { items?: QuotaBatchItemView[]; previewToken?: string } = {}): QuotaBatchView {
  return {
    id: row.id,
    period: row.period,
    scope: row.scope,
    status: row.status,
    ...(options.previewToken ? { previewToken: options.previewToken } : {}),
    targetCount: row.targetCount,
    pendingCount: row.pendingCount,
    grantedCount: row.grantedCount,
    zeroCount: row.zeroCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    totalCredits: row.totalCredits,
    issuedCredits: row.issuedCredits,
    scopeTotal: row.scopeTotal,
    truncated: row.truncated,
    createdBy: String(row.createdBy),
    createTime: row.createTime,
    startedTime: row.startedTime,
    finishedTime: row.finishedTime,
    ...(options.items ? { items: options.items } : {}),
  };
}

function itemViewOf(row: ItemRow, account: string | null, name: string | null): QuotaBatchItemView {
  return {
    userId: String(row.userId),
    userAccount: account,
    userName: name,
    baseCredits: row.baseCredits,
    policySource: row.policySource,
    policyVersion: row.policyVersion,
    status: row.status,
    issueId: row.issueId,
    reason: row.reason,
    updateTime: row.updateTime,
  };
}

async function itemsOf(batchId: string): Promise<QuotaBatchItemView[]> {
  const rows = await db().select({
    item: creditQuotaBatchItems,
    account: users.userAccount,
    name: users.userName,
  }).from(creditQuotaBatchItems)
    .leftJoin(users, eq(users.id, creditQuotaBatchItems.userId))
    .where(eq(creditQuotaBatchItems.batchId, batchId))
    .orderBy(asc(creditQuotaBatchItems.userId))
    .limit(itemViewLimit);
  return rows.map(row => itemViewOf(row.item, row.account, row.name));
}

async function loadBatch(batchId: string): Promise<BatchRow> {
  const [row] = await db().select().from(creditQuotaBatches).where(eq(creditQuotaBatches.id, batchId)).limit(1);
  if (!row) throw new BusinessError(404, 40400, '批次不存在');
  return row;
}

/** 预览时解析一个用户的基础发放事实：已发 = skipped，legacy grant 优先，否则读策略。 */
async function resolvePreviewBase(userId: bigint, period: string): Promise<{
  status: 'pending' | 'skipped';
  baseCredits: number;
  source: QuotaPolicySource;
  version: number | null;
  policyId: string | null;
  issueId: string | null;
}> {
  const [issue] = await db().select().from(creditQuotaIssues)
    .where(and(eq(creditQuotaIssues.userId, userId), eq(creditQuotaIssues.period, period)))
    .limit(1);
  if (issue?.status === 'granted') {
    return {
      status: 'skipped', baseCredits: issue.baseCredits, source: issue.policySource,
      version: issue.policyVersion, policyId: issue.policyId, issueId: issue.id,
    };
  }
  const [legacy] = await db().select().from(creditGrants)
    .where(and(
      eq(creditGrants.userId, userId),
      eq(creditGrants.source, 'monthly_quota'),
      eq(creditGrants.period, period),
    )).limit(1);
  if (legacy) {
    return { status: 'pending', baseCredits: legacy.credits, source: 'legacy', version: null, policyId: null, issueId: null };
  }
  const policy = await resolveQuotaPolicy(db(), userId, period);
  return { status: 'pending', baseCredits: policy.credits, source: policy.source, version: policy.version, policyId: policy.policyId, issueId: null };
}

type PreviewTarget = { userId: bigint; account: string | null; name: string | null };

/** 预览批次：只写批次与逐用户快照，不写 grant/issue。 */
export async function previewQuotaBatch(input: QuotaBatchPreviewRequest, operatorId: string): Promise<QuotaBatchView> {
  const period = periodOf(new Date());
  if (input.period && input.period !== period) {
    throw new BusinessError(400, 40000, input.period < period
      ? '已结束月份不能补发可用配额；请只对当前账期发放'
      : '不能提前把未来账期配额计入当前余额');
  }
  const limit = input.limit ?? maxQuotaBatchUsers;
  const scope: QuotaBatchScope = input.scope;
  const restrictedIds = input.userIds?.map(id => BigInt(id)) ?? null;
  let targets: PreviewTarget[] = [];
  let scopeTotal = 0;
  let truncated = false;

  if (scope === 'pending') {
    const granted = db().select({ userId: creditQuotaIssues.userId }).from(creditQuotaIssues)
      .where(and(eq(creditQuotaIssues.period, period), eq(creditQuotaIssues.status, 'granted')));
    const conditions = [eq(users.isDelete, 0), notInArray(users.id, granted)];
    if (restrictedIds?.length) conditions.push(inArray(users.id, restrictedIds));
    const where = and(...conditions);
    const [countRow] = await db().select({ count: sql<string>`count(*)` }).from(users).where(where);
    scopeTotal = Number(countRow?.count ?? 0);
    const rows = await db().select({ id: users.id, account: users.userAccount, name: users.userName }).from(users)
      .where(where)
      .orderBy(asc(users.id))
      .limit(limit);
    targets = rows.map(row => ({ userId: row.id, account: row.account, name: row.name }));
    truncated = scopeTotal > targets.length;
  } else {
    const ids = restrictedIds ?? [];
    scopeTotal = ids.length;
    const rows = await db().select({ id: users.id, account: users.userAccount, name: users.userName }).from(users)
      .where(and(inArray(users.id, ids), eq(users.isDelete, 0)));
    const byId = new Map(rows.map(row => [String(row.id), row]));
    targets = ids.map(id => {
      const row = byId.get(String(id));
      return { userId: id, account: row?.account ?? null, name: row?.name ?? null };
    });
  }

  if (targets.length === 0) throw new BusinessError(400, 40000, '没有可发放的用户');

  const items: {
    userId: bigint; account: string | null; name: string | null; status: QuotaBatchItemStatus;
    baseCredits: number; source: QuotaPolicySource; version: number | null; policyId: string | null;
    issueId: string | null; reason: string | null;
  }[] = [];
  for (const target of targets) {
    if (target.account === null) {
      items.push({
        ...target, status: 'failed', baseCredits: 0, source: 'fallback', version: null, policyId: null,
        issueId: null, reason: '用户不存在或已删除',
      });
      continue;
    }
    const resolved = await resolvePreviewBase(target.userId, period);
    items.push({
      ...target,
      status: resolved.status,
      baseCredits: resolved.baseCredits,
      source: resolved.source,
      version: resolved.version,
      policyId: resolved.policyId,
      issueId: resolved.issueId,
      reason: resolved.status === 'skipped' ? '该账期已发' : null,
    });
  }

  const previewToken = randomBytes(32).toString('hex');
  const pending = items.filter(item => item.status === 'pending');
  const skipped = items.filter(item => item.status === 'skipped').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const totalCredits = pending.reduce((sum, item) => sum + item.baseCredits, 0);
  const fingerprint = fingerprintOf(period, items.map(item => ({
    userId: String(item.userId), baseCredits: item.baseCredits, source: item.source, version: item.version,
  })));

  const batch = await db().transaction(async tx => {
    const [row] = await tx.insert(creditQuotaBatches).values({
      id: randomUUID(),
      period,
      scope,
      selection: { kind: scope, ...(restrictedIds?.length ? { userIds: restrictedIds.map(String) } : {}) },
      previewToken,
      previewFingerprint: fingerprint,
      status: 'previewed',
      targetCount: items.length,
      pendingCount: pending.length,
      grantedCount: 0,
      zeroCount: 0,
      skippedCount: skipped,
      failedCount: failed,
      totalCredits,
      issuedCredits: 0,
      scopeTotal,
      truncated,
      createdBy: BigInt(operatorId),
      createTime: now(),
    }).returning();
    if (items.length) {
      await tx.insert(creditQuotaBatchItems).values(items.map(item => ({
        batchId: row.id,
        userId: item.userId,
        baseCredits: item.baseCredits,
        policySource: item.source,
        policyVersion: item.version,
        policyId: item.policyId,
        status: item.status,
        issueId: item.issueId,
        reason: item.reason,
        updateTime: now(),
      })));
    }
    return row;
  });
  return batchViewOf(batch, { items: items.map(item => ({
    userId: String(item.userId), userAccount: item.account, userName: item.name,
    baseCredits: item.baseCredits, policySource: item.source, policyVersion: item.version,
    status: item.status, issueId: item.issueId, reason: item.reason, updateTime: batch.createTime,
  })), previewToken });
}

/** 重新计算批次计数；执行/重试后调用，避免增量计数与真实 item 状态漂移。 */
async function refreshBatchCounts(batchId: string, extra: { started?: boolean } = {}): Promise<BatchRow> {
  const rows = await db().select({
    status: creditQuotaBatchItems.status,
    count: sql<string>`count(*)`,
    credits: sql<string>`coalesce(sum(${creditQuotaBatchItems.baseCredits}), 0)`,
    zeros: sql<string>`count(*) filter (where ${creditQuotaBatchItems.status} = 'granted' and ${creditQuotaBatchItems.baseCredits} = 0)`,
  }).from(creditQuotaBatchItems)
    .where(eq(creditQuotaBatchItems.batchId, batchId))
    .groupBy(creditQuotaBatchItems.status);
  const byStatus = new Map(rows.map(row => [row.status, row]));
  const pending = Number(byStatus.get('pending')?.count ?? 0);
  const granted = Number(byStatus.get('granted')?.count ?? 0);
  const skipped = Number(byStatus.get('skipped')?.count ?? 0);
  const failed = Number(byStatus.get('failed')?.count ?? 0);
  const zero = Number(byStatus.get('granted')?.zeros ?? 0);
  const issued = Number(byStatus.get('granted')?.credits ?? 0);
  const status: QuotaBatchStatus = pending > 0 ? 'running' : failed > 0 ? 'completed' : 'completed';
  const [row] = await db().update(creditQuotaBatches).set({
    status,
    pendingCount: pending,
    grantedCount: granted,
    zeroCount: zero,
    skippedCount: skipped,
    failedCount: failed,
    issuedCredits: issued,
    ...(extra.started ? { startedTime: now() } : {}),
    ...(pending === 0 ? { finishedTime: now() } : { finishedTime: null }),
  }).where(eq(creditQuotaBatches.id, batchId)).returning();
  return row;
}

/**
 * 执行/继续执行一个批次。先校验全部 pending 项的策略快照，再处理最多 `limit` 项；
 * 校验失败把批次标记为 superseded，且不写任何发放事实。
 */
export async function executeQuotaBatch(input: QuotaBatchExecuteRequest, operatorId: string): Promise<QuotaBatchView> {
  const batch = await loadBatch(input.batchId);
  if (batch.previewToken !== input.previewToken) throw new BusinessError(400, 40000, '预览令牌不匹配，请重新预览');
  if (!['previewed', 'running'].includes(batch.status)) {
    throw new BusinessError(409, 40900, '这个批次当前不能执行；请刷新后重新预览或重试失败项');
  }
  const period = periodOf(new Date());
  if (batch.period !== period) {
    await db().update(creditQuotaBatches).set({ status: 'superseded', finishedTime: now() })
      .where(eq(creditQuotaBatches.id, batch.id));
    throw new BusinessError(409, 40900, '批次账期已经不是当前账期；请重新预览当月发放');
  }

  const allItems = await db().select().from(creditQuotaBatchItems).where(eq(creditQuotaBatchItems.batchId, batch.id));
  for (const item of allItems.filter(row => row.status === 'pending')) {
    const resolved = await resolvePreviewBase(item.userId, period);
    if (resolved.status === 'skipped') continue;
    if (resolved.baseCredits !== item.baseCredits || resolved.source !== item.policySource
      || resolved.version !== item.policyVersion) {
      await db().update(creditQuotaBatches).set({ status: 'superseded', finishedTime: now() })
        .where(eq(creditQuotaBatches.id, batch.id));
      throw new BusinessError(409, 40900, '策略在预览后发生变化，旧预览已失效；请重新预览');
    }
  }

  const limit = input.limit ?? 200;
  const pending = allItems.filter(row => row.status === 'pending').slice(0, limit);
  if (batch.status === 'previewed') {
    await db().update(creditQuotaBatches).set({ status: 'running', startedTime: now() })
      .where(eq(creditQuotaBatches.id, batch.id));
  }

  for (const item of pending) {
    if (periodOf(new Date()) !== batch.period) {
      await db().update(creditQuotaBatches).set({ status: 'superseded', finishedTime: now() })
        .where(eq(creditQuotaBatches.id, batch.id));
      throw new BusinessError(409, 40900, '执行过程中跨月，批次已失效；请重新预览当月发放');
    }
    try {
      const result = await ensurePeriodQuota(String(item.userId), new Date());
      if (!result.granted) {
        await db().update(creditQuotaBatchItems).set({
          status: 'skipped', issueId: result.issue.id, reason: '已发（并发入口或重复执行）', updateTime: now(),
        }).where(and(eq(creditQuotaBatchItems.batchId, batch.id), eq(creditQuotaBatchItems.userId, item.userId)));
        continue;
      }
      await db().update(creditQuotaBatchItems).set({
        status: 'granted',
        issueId: result.issue.id,
        baseCredits: result.issue.baseCredits,
        reason: null,
        updateTime: now(),
      }).where(and(eq(creditQuotaBatchItems.batchId, batch.id), eq(creditQuotaBatchItems.userId, item.userId)));
    } catch (error) {
      const message = error instanceof BusinessError ? error.message : '发放失败';
      await db().update(creditQuotaBatchItems).set({
        status: 'failed', reason: message.slice(0, 500), updateTime: now(),
      }).where(and(eq(creditQuotaBatchItems.batchId, batch.id), eq(creditQuotaBatchItems.userId, item.userId)));
    }
  }
  const row = await refreshBatchCounts(batch.id, { started: batch.status === 'previewed' });
  return batchViewOf(row, { items: await itemsOf(batch.id) });
}

/** 重试失败项：只把 failed 改回 pending，成功/跳过项不动；返回带令牌的批次视图供继续执行。 */
export async function retryQuotaBatch(batchId: string, operatorId: string): Promise<QuotaBatchView> {
  const batch = await loadBatch(batchId);
  if (!['completed', 'running'].includes(batch.status)) {
    throw new BusinessError(409, 40900, '只有已完成或执行中的批次可以重试失败项');
  }
  const failed = await db().select({ userId: creditQuotaBatchItems.userId })
    .from(creditQuotaBatchItems)
    .where(and(eq(creditQuotaBatchItems.batchId, batchId), eq(creditQuotaBatchItems.status, 'failed')));
  if (failed.length === 0) throw new BusinessError(409, 40900, '这个批次没有失败项');
  await db().update(creditQuotaBatchItems).set({ status: 'pending', reason: null, updateTime: now() })
    .where(and(eq(creditQuotaBatchItems.batchId, batchId), eq(creditQuotaBatchItems.status, 'failed')));
  const row = await refreshBatchCounts(batchId);
  // 令牌只用于继续执行同一条预览；这里返回给当前 Admin，列表接口不返回。
  return batchViewOf(row, { items: await itemsOf(batchId), previewToken: batch.previewToken });
}

export async function listQuotaBatches(input: { limit: number }): Promise<QuotaBatchView[]> {
  const rows = await db().select().from(creditQuotaBatches)
    .orderBy(desc(creditQuotaBatches.createTime), desc(creditQuotaBatches.id))
    .limit(input.limit);
  return rows.map(row => batchViewOf(row));
}
