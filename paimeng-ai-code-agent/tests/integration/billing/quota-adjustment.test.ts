import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingBalancesOf,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  purgeBillingRateCards,
  seedBillingApp,
  seedBillingGeneration,
  seedBillingRate,
  seedBillingStep,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import {
  apps, creditAccounts, creditCharges, creditEntries, creditGrants, creditQuotaAdjustments,
  creditQuotaIssues, generations, sessions, users,
} from '@/server/infra/schema';
import { adjustQuota } from '@/server/billing/quota-adjustment';
import { quotaFactsOfPeriod } from '@/server/billing/quota-facts';
import { rebuildAccount } from '@/server/billing/ledger';
import { settleGenerationBilling } from '@/server/billing/settlement';
import { ensureCurrentPeriod } from '@/server/billing/quota';
import { auditAccount } from '@/server/billing/settlement';
import { nextPeriodOf } from '@/server/billing/quota-policy';
import { periodOf } from '@/server/billing/period';
import { monthlyQuotaCredits, type QuotaAdjustmentReceipt, type AccountSummary } from '@/shared/billing';

/**
 * C3 单用户当月配额调整：增加/扣回/目标剩余、理由与幂等、统一重算、并发结算不丢钱。
 */

const created: BillingTestUser[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];
let admin: BillingTestUser;

const period = periodOf(new Date());

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql',
    '020_credit_quota_policy.sql', '021_credit_quota_adjustment.sql', '022_credit_quota_batch.sql', '023_app_config_model_config.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const userIds = [...created.map(user => BigInt(user.id)), BigInt(admin.id)];
  if (createdGenerations.length) {
    await db().delete(creditEntries).where(inArray(creditEntries.chargeId, createdGenerations));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, createdGenerations));
    await db().delete(generations).where(inArray(generations.id, createdGenerations));
  }
  if (createdApps.length) await db().delete(apps).where(inArray(apps.id, createdApps));
  await db().delete(creditQuotaAdjustments).where(inArray(creditQuotaAdjustments.userId, userIds));
  await db().delete(creditQuotaIssues).where(inArray(creditQuotaIssues.userId, userIds));
  await db().delete(creditGrants).where(inArray(creditGrants.userId, userIds));
  await db().delete(creditAccounts).where(inArray(creditAccounts.userId, userIds));
  await db().delete(sessions).where(inArray(sessions.userId, userIds));
  await db().delete(users).where(inArray(users.id, userIds));
  await purgeBillingRateCards();
  await getPool().end();
});

async function newUser(): Promise<BillingTestUser> {
  const user = await createBillingUser();
  created.push(user);
  return user;
}

async function adjust(payload: Record<string, unknown>, session = admin.cookie): Promise<Response> {
  return billingRequest('admin/billing/quota/adjust', payload, session);
}

async function adjustOk(payload: Record<string, unknown>): Promise<QuotaAdjustmentReceipt> {
  const response = await adjust(payload);
  expect(response.status).toBe(200);
  return (await envelopeOf<QuotaAdjustmentReceipt>(response)).data;
}

async function summaryOf(user: BillingTestUser): Promise<AccountSummary> {
  return (await envelopeOf<AccountSummary>(await billingRequest('billing/summary', undefined, user.cookie))).data;
}

async function adjustmentsOf(userId: string) {
  return db().select().from(creditQuotaAdjustments)
    .where(eq(creditQuotaAdjustments.userId, BigInt(userId)))
    .orderBy(creditQuotaAdjustments.createTime);
}

describe('POST admin/billing/quota/adjust', () => {
  it('增加、扣回、设目标剩余都按统一口径落调整行并重算快照', async () => {
    const user = await newUser();
    const first = await adjustOk({
      userId: user.id, mode: 'increase', amount: 100, reason: '投诉补偿', requestId: 'adj-inc-1',
    });
    expect(first).toMatchObject({ created: true, period, beforeCredits: 500, afterCredits: 600 });
    expect(first.adjustment).toMatchObject({ mode: 'increase', credits: 100, beforeCredits: 500, afterCredits: 600 });

    const second = await adjustOk({
      userId: user.id, mode: 'decrease', amount: 50, reason: '修正误发', requestId: 'adj-dec-1',
    });
    expect(second).toMatchObject({ beforeCredits: 600, afterCredits: 550 });
    expect(second.adjustment.credits).toBe(-50);

    const third = await adjustOk({
      userId: user.id, mode: 'target', amount: 350, reason: '统一到 350', requestId: 'adj-target-1',
    });
    expect(third).toMatchObject({ beforeCredits: 550, afterCredits: 350 });
    expect(third.adjustment.credits).toBe(-200);

    const facts = await quotaFactsOfPeriod(db(), BigInt(user.id), period);
    expect(facts).toMatchObject({
      baseCredits: monthlyQuotaCredits, adjustmentCredits: -150, usedCredits: 0, remainingCredits: 350,
    });
    expect(await billingBalancesOf(user.id)).toEqual({ quota: 350, balance: 0 });
    // 刷新摘要、rebuild、audit 都读同一口径，调整不会被抹掉。
    expect(await summaryOf(user)).toMatchObject({ quota: 350, quotaBase: 500, quotaAdjustments: -150, quotaUsed: 0 });
    expect(await rebuildAccount(user.id)).toEqual({ quota: 350, balance: 0 });
    expect(await auditAccount(user.id)).toEqual({ expected: { quota: 350, balance: 0 }, actual: { quota: 350, balance: 0 }, diff: { quota: 0, balance: 0 } });
    expect(await adjustmentsOf(user.id)).toHaveLength(3);
  });

  it('扣回不能超过当前有效剩余；目标相同不写行；理由为空由契约拒绝', async () => {
    const user = await newUser();
    const tooMuch = await adjust({
      userId: user.id, mode: 'decrease', amount: 501, reason: '超额扣回', requestId: 'adj-too-much',
    });
    expect(tooMuch.status).toBe(409);
    expect(await adjustmentsOf(user.id)).toHaveLength(0);
    expect(await billingBalancesOf(user.id)).toEqual({ quota: 500, balance: 0 });

    const same = await adjust({
      userId: user.id, mode: 'target', amount: 500, reason: '不变', requestId: 'adj-same',
    });
    expect(same.status).toBe(400);
    expect(await adjustmentsOf(user.id)).toHaveLength(0);

    const emptyReason = await adjust({
      userId: user.id, mode: 'increase', amount: 1, reason: '   ', requestId: 'adj-empty',
    });
    expect(emptyReason.status).toBe(400);
    expect(await adjustmentsOf(user.id)).toHaveLength(0);

    const past = await adjust({
      userId: user.id, mode: 'increase', amount: 1, reason: '旧账期', requestId: 'adj-past', period: '2020-01',
    });
    expect(past.status).toBe(400);
    const future = await adjust({
      userId: user.id, mode: 'increase', amount: 1, reason: '未来账期', requestId: 'adj-future', period: nextPeriodOf(period),
    });
    expect(future.status).toBe(400);
  });

  it('同 requestId 同载荷返回原回执，不重复变更；同键异载荷 409', async () => {
    const user = await newUser();
    const payload = { userId: user.id, mode: 'increase', amount: 40, reason: '重试幂等', requestId: 'adj-idem-1' };
    const first = await adjustOk(payload);
    const replay = await adjustOk(payload);
    expect(replay).toMatchObject({ created: false, beforeCredits: first.beforeCredits, afterCredits: first.afterCredits });
    expect(await adjustmentsOf(user.id)).toHaveLength(1);
    expect(await billingBalancesOf(user.id)).toEqual({ quota: 540, balance: 0 });

    const conflict = await adjust({ ...payload, amount: 41 });
    expect(conflict.status).toBe(409);
    expect(await adjustmentsOf(user.id)).toHaveLength(1);
    expect(await billingBalancesOf(user.id)).toEqual({ quota: 540, balance: 0 });
  });

  it('普通用户 403，不存在的用户 404', async () => {
    const plain = await newUser();
    expect((await adjust({
      userId: plain.id, mode: 'increase', amount: 1, reason: '越权', requestId: 'adj-denied',
    }, plain.cookie)).status).toBe(403);
    expect((await adjust({
      userId: '999999999', mode: 'increase', amount: 1, reason: '不存在', requestId: 'adj-missing',
    })).status).toBe(404);
  });

  it('调整与结算并发：最终配额 = 基础 + 调整 − 消费，两池自洽', async () => {
    const user = await newUser();
    await seedBillingRate({ modelName: 'model-adjust-concurrent' });
    const app = await seedBillingApp(user.id);
    createdApps.push(BigInt(app.id));
    const generationId = await seedBillingGeneration({ appId: app.id, userId: user.id });
    createdGenerations.push(generationId);
    await seedBillingStep(generationId, { modelName: 'model-adjust-concurrent', input: 500_000 });

    await Promise.all([
      settleGenerationBilling(generationId),
      adjustQuota({
        userId: user.id, mode: 'increase', amount: 100, reason: '并发补偿', requestId: 'adj-concurrent',
      }, admin.id),
    ]);

    const facts = await quotaFactsOfPeriod(db(), BigInt(user.id), period);
    // 基础 500 + 调整 100 − 消费 300 = 300；先结算或先调整都应得到同一个数。
    expect(facts).toMatchObject({ baseCredits: 500, adjustmentCredits: 100, usedCredits: 300, remainingCredits: 300 });
    expect(await billingBalancesOf(user.id)).toEqual({ quota: 300, balance: 0 });
    expect(await auditAccount(user.id)).toMatchObject({ diff: { quota: 0, balance: 0 } });
  });

  it('调整只属于当前账期，不会写进下个月', async () => {
    const user = await newUser();
    await adjustOk({ userId: user.id, mode: 'increase', amount: 30, reason: '本月补偿', requestId: 'adj-period' });
    const current = await quotaFactsOfPeriod(db(), BigInt(user.id), period);
    const next = await quotaFactsOfPeriod(db(), BigInt(user.id), nextPeriodOf(period));
    expect(current.remainingCredits).toBe(530);
    expect(next.remainingCredits).toBe(0);
    expect(next.adjustmentCredits).toBe(0);
    expect(await ensureCurrentPeriod(user.id)).toMatchObject({ quota: 530, quotaAdjustments: 30 });
  });
});
