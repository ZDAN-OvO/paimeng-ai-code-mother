import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingBalancesOf,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  withoutMonthlyQuota,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool, now } from '@/server/infra/db';
import {
  creditAccounts, creditGrants, creditQuotaAdjustments, creditQuotaBatchItems, creditQuotaBatches,
  creditQuotaIssues, creditQuotaPolicies, sessions, users,
} from '@/server/infra/schema';
import { ensurePeriodQuota } from '@/server/billing/quota';
import { periodOf } from '@/server/billing/period';
import { nextPeriodOf } from '@/server/billing/quota-policy';
import type { QuotaBatchView } from '@/shared/billing';

/**
 * C4 批量发放：预览固定范围/策略、确认执行、分批继续、部分失败重试、并发懒发放与旧预览失效。
 */

const createdUsers: BillingTestUser[] = [];
const createdBatches: string[] = [];
let admin: BillingTestUser;
const period = periodOf(new Date());

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations(
    '010_credit_grant_account.sql', '012_credit_charge_entry.sql', '020_credit_quota_policy.sql',
    '021_credit_quota_adjustment.sql', '022_credit_quota_batch.sql', '023_app_config_model_config.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const userIds = [...createdUsers.map(user => BigInt(user.id)), BigInt(admin.id)];
  if (createdBatches.length) {
    await db().delete(creditQuotaBatchItems).where(inArray(creditQuotaBatchItems.batchId, createdBatches));
    await db().delete(creditQuotaBatches).where(inArray(creditQuotaBatches.id, createdBatches));
  }
  await db().delete(creditQuotaBatches).where(eq(creditQuotaBatches.createdBy, BigInt(admin.id)));
  await db().delete(creditQuotaPolicies).where(inArray(creditQuotaPolicies.userId, userIds));
  await db().delete(creditQuotaPolicies).where(inArray(creditQuotaPolicies.createdBy, userIds));
  await db().delete(creditQuotaAdjustments).where(inArray(creditQuotaAdjustments.userId, userIds));
  await db().delete(creditQuotaIssues).where(inArray(creditQuotaIssues.userId, userIds));
  await db().delete(creditGrants).where(inArray(creditGrants.userId, userIds));
  await db().delete(creditAccounts).where(inArray(creditAccounts.userId, userIds));
  await db().delete(sessions).where(inArray(sessions.userId, userIds));
  await db().delete(users).where(inArray(users.id, userIds));
  await getPool().end();
});

async function pendingUser(): Promise<BillingTestUser> {
  const user = await createBillingUser();
  createdUsers.push(user);
  await withoutMonthlyQuota(user);
  return user;
}

async function preview(payload: Record<string, unknown>, session = admin.cookie): Promise<Response> {
  return billingRequest('admin/billing/quota/batch/preview', payload, session);
}

async function previewOk(payload: Record<string, unknown>): Promise<QuotaBatchView> {
  const response = await preview(payload);
  expect(response.status).toBe(200);
  const batch = (await envelopeOf<QuotaBatchView>(response)).data;
  createdBatches.push(batch.id);
  return batch;
}

async function execute(batch: QuotaBatchView, limit?: number, session = admin.cookie): Promise<Response> {
  return billingRequest('admin/billing/quota/batch/execute', {
    batchId: batch.id, previewToken: batch.previewToken, ...(limit ? { limit } : {}),
  }, session);
}

async function executeOk(batch: QuotaBatchView, limit?: number): Promise<QuotaBatchView> {
  const response = await execute(batch, limit);
  expect(response.status).toBe(200);
  return (await envelopeOf<QuotaBatchView>(response)).data;
}

async function grantsOf(userId: string) {
  return db().select().from(creditGrants)
    .where(and(eq(creditGrants.userId, BigInt(userId)), eq(creditGrants.source, 'monthly_quota'), eq(creditGrants.period, period)));
}

async function issuesOf(userId: string) {
  return db().select().from(creditQuotaIssues)
    .where(and(eq(creditQuotaIssues.userId, BigInt(userId)), eq(creditQuotaIssues.period, period)));
}

describe('批量预览与执行', () => {
  it('预览按上限截断且不写发放；确认后分批执行，全部完成后计数正确', async () => {
    const users = [await pendingUser(), await pendingUser(), await pendingUser()];
    const ids = users.map(user => user.id);
    // 预览 limit 只截取目标，不代表批次只能处理这些目标；scopeTotal/truncated 如实标出剩余。
    const truncated = await previewOk({ scope: 'pending', userIds: ids, limit: 2 });
    expect(truncated).toMatchObject({
      period, scope: 'pending', status: 'previewed', targetCount: 2, pendingCount: 2,
      scopeTotal: 3, truncated: true, totalCredits: 1000, grantedCount: 0,
    });
    expect(truncated.items).toHaveLength(2);
    expect(truncated.items?.every(item => item.status === 'pending' && item.baseCredits === 500)).toBe(true);
    expect(await issuesOf(users[0].id)).toHaveLength(0);

    // 完整预览 3 人，执行时每批 2 人：第一次 running，第二次 completed。
    const batch = await previewOk({ scope: 'pending', userIds: ids });
    expect(batch).toMatchObject({ targetCount: 3, pendingCount: 3, scopeTotal: 3, truncated: false, totalCredits: 1500 });
    const first = await executeOk(batch, 2);
    expect(first).toMatchObject({ status: 'running', grantedCount: 2, pendingCount: 1, issuedCredits: 1000 });
    expect(await issuesOf(users[0].id)).toHaveLength(1);
    expect(await grantsOf(users[0].id)).toHaveLength(1);

    const second = await executeOk(batch);
    expect(second).toMatchObject({ status: 'completed', grantedCount: 3, pendingCount: 0, issuedCredits: 1500 });
    expect(await issuesOf(users[2].id)).toHaveLength(1);
    expect(await billingBalancesOf(users[2].id)).toEqual({ quota: 500, balance: 0 });

    const none = await preview({ scope: 'pending', userIds: ids });
    expect(none.status).toBe(400);
  });

  it('指定用户里已发项显示 skipped，执行时不重复发', async () => {
    const granted = await createBillingUser();
    createdUsers.push(granted);
    const pending = await pendingUser();
    const before = await grantsOf(granted.id);

    const batch = await previewOk({ scope: 'users', userIds: [granted.id, pending.id] });
    expect(batch).toMatchObject({ targetCount: 2, pendingCount: 1, skippedCount: 1, totalCredits: 500 });
    expect(batch.items?.find(item => item.userId === granted.id)?.status).toBe('skipped');

    const done = await executeOk(batch);
    expect(done).toMatchObject({ status: 'completed', grantedCount: 1, skippedCount: 1, pendingCount: 0 });
    expect(await grantsOf(granted.id)).toHaveLength(before.length);
    expect(await grantsOf(pending.id)).toHaveLength(1);
  });

  it('预览后策略变化会让旧批次 superseded，且不写 issue/grant', async () => {
    const user = await pendingUser();
    const batch = await previewOk({ scope: 'pending', userIds: [user.id] });
    expect(batch.items?.[0].baseCredits).toBe(500);

    await db().insert(creditQuotaPolicies).values({
      id: crypto.randomUUID(), scope: 'user', userId: BigInt(user.id), effectivePeriod: period,
      mode: 'override', credits: 700, revision: 1, note: '测试旧预览失效', createdBy: BigInt(admin.id),
      createTime: now(),
    });
    const stale = await execute(batch);
    expect(stale.status).toBe(409);
    const [row] = await db().select().from(creditQuotaBatches).where(eq(creditQuotaBatches.id, batch.id));
    expect(row.status).toBe('superseded');
    expect(await issuesOf(user.id)).toHaveLength(0);
    expect(await grantsOf(user.id)).toHaveLength(0);
  });

  it('部分失败重试：成功项不重复，失败项修好后补发', async () => {
    const first = await pendingUser();
    const second = await pendingUser();
    const batch = await previewOk({ scope: 'pending', userIds: [first.id, second.id] });

    const [secondRow] = await db().select().from(users).where(eq(users.id, BigInt(second.id)));
    await db().delete(users).where(eq(users.id, BigInt(second.id)));
    await db().delete(sessions).where(eq(sessions.userId, BigInt(second.id)));

    const partial = await executeOk(batch);
    expect(partial).toMatchObject({ status: 'completed', grantedCount: 1, failedCount: 1, pendingCount: 0 });
    expect(partial.items?.find(item => item.userId === second.id)?.status).toBe('failed');
    expect(await grantsOf(first.id)).toHaveLength(1);
    expect(await issuesOf(second.id)).toHaveLength(0);

    // 修复失败项：同一个用户 ID 重新存在后，重试只跑 failed。
    await db().insert(users).values(secondRow);
    const retry = await billingRequest('admin/billing/quota/batch/retry', { batchId: batch.id }, admin.cookie);
    expect(retry.status).toBe(200);
    const retried = (await envelopeOf<QuotaBatchView>(retry)).data;
    expect(retried).toMatchObject({ status: 'running', pendingCount: 1, failedCount: 0 });
    const fixed = await executeOk(retried);
    expect(fixed).toMatchObject({ status: 'completed', grantedCount: 2, failedCount: 0 });
    expect(await grantsOf(first.id)).toHaveLength(1);
    expect(await grantsOf(second.id)).toHaveLength(1);
  });

  it('并发懒发放先落地时，批次只把该项标为 skipped', async () => {
    const user = await pendingUser();
    const batch = await previewOk({ scope: 'pending', userIds: [user.id] });
    await ensurePeriodQuota(user.id);

    const done = await executeOk(batch);
    expect(done).toMatchObject({ status: 'completed', grantedCount: 0, skippedCount: 1, pendingCount: 0 });
    expect(await issuesOf(user.id)).toHaveLength(1);
    expect(await grantsOf(user.id)).toHaveLength(1);
  });

  it('跨月或批次账期过期时拒绝执行，不复活旧账期', async () => {
    const user = await pendingUser();
    const batch = await previewOk({ scope: 'pending', userIds: [user.id] });
    await db().update(creditQuotaBatches).set({ period: nextPeriodOf(period) })
      .where(eq(creditQuotaBatches.id, batch.id));
    const stale = await execute(batch);
    expect(stale.status).toBe(409);
    const [row] = await db().select().from(creditQuotaBatches).where(eq(creditQuotaBatches.id, batch.id));
    expect(row.status).toBe('superseded');
    expect(await issuesOf(user.id)).toHaveLength(0);
  });

  it('新用户不会被旧批次混入；权限与空批次边界明确', async () => {
    const first = await pendingUser();
    const second = await pendingUser();
    const batch = await previewOk({ scope: 'pending', userIds: [first.id, second.id] });

    const late = await pendingUser();
    const done = await executeOk(batch);
    expect(done.items?.map(item => item.userId)).not.toContain(late.id);
    expect(await grantsOf(late.id)).toHaveLength(0);
    const lateBatch = await previewOk({ scope: 'pending', userIds: [late.id] });
    expect(lateBatch.pendingCount).toBe(1);

    const plain = await pendingUser();
    expect((await preview({ scope: 'pending', userIds: [plain.id] }, plain.cookie)).status).toBe(403);
    expect((await execute(batch, undefined, plain.cookie)).status).toBe(403);
    expect((await preview({ scope: 'pending', userIds: ['999999999'] })).status).toBe(400);
  });
});
