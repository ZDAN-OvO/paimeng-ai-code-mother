import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { creditBalance, creditCharges, creditLedger, sessions, users } from '@/server/infra/schema';
import { rebuildBalance } from '@/server/billing/ledger';
import { naiveTime, periodOf, periodRange } from '@/server/billing/period';
import type {
  AdminCreditOverview,
  AdminUserCreditDetail,
  AdminUserSearchResult,
} from '@/shared/billing';

/**
 * 全用户积分总览：不需要当期发放也能看到用户；统计按筛选范围而不是当前页；
 * 金额来自账本；浏览列表不写库。
 */

const prefix = 'overview_' + randomUUID().slice(0, 8);
const createdIds: bigint[] = [];
let admin: BillingTestUser;

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('024_credit_ledger.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const ids = [...createdIds, BigInt(admin.id)];
  if (ids.length) {
    const scope = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await db().execute(sql`delete from credit_ledger
      where charge_id in (select generation_id from credit_charge where user_id in (${scope}))`);
    await db().execute(sql`delete from credit_charge where user_id in (${scope})`);
    await db().delete(creditLedger).where(inArray(creditLedger.userId, ids));
    await db().delete(creditBalance).where(inArray(creditBalance.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

async function createUser(account: string, userName: string | null): Promise<bigint> {
  const id = await nextSnowflakeId();
  createdIds.push(id);
  await db().insert(users).values({
    id,
    userAccount: account,
    userPassword: 'not-used',
    userName,
    userRole: 'user',
    createTime: now(),
    updateTime: now(),
  });
  return id;
}

const period = () => periodOf(new Date());

async function grant(userId: bigint, bucket: 'limited' | 'lasting', credits: number) {
  const target = period();
  await db()
    .insert(creditLedger)
    .values({
      userId,
      kind: bucket === 'limited' ? 'quota' : 'grant',
      origin: bucket === 'limited' ? 'rule' : 'manual',
      credits,
      period: bucket === 'limited' ? target : null,
      expiresAt: bucket === 'limited' ? naiveTime(periodRange(target).end) : null,
      createTime: now(),
    });
  await rebuildBalance(String(userId));
}

/** 造一条 Charge 与它的消费行；三段分别落在限时/长期。 */
async function charge(
  userId: bigint,
  entries: { bucket: 'limited' | 'lasting'; credits: number }[],
) {
  const generationId = randomUUID();
  const target = period();
  await db()
    .insert(creditCharges)
    .values({
      generationId,
      appId: 0n,
      userId,
      credits: entries.reduce((sum, entry) => sum + entry.credits, 0),
      costUsd: null,
      rateCardSnapshot: [],
      usageSnapshot: [],
      status: 'settled',
      estimatedSteps: 0,
      createTime: now(),
    });
  for (const entry of entries) {
    await db()
      .insert(creditLedger)
      .values({
        userId,
        kind: 'consume',
        origin: 'charge',
        credits: -entry.credits,
        period: entry.bucket === 'limited' ? target : null,
        expiresAt: entry.bucket === 'limited' ? naiveTime(periodRange(target).end) : null,
        chargeId: generationId,
        createTime: now(),
      });
  }
  await rebuildBalance(String(userId));
  return generationId;
}

async function overview(query = '') {
  const response = await billingRequest(`admin/billing/overview?${query}`, undefined, admin.cookie);
  expect(response.status).toBe(200);
  return (await envelopeOf<AdminCreditOverview>(response)).data;
}

describe('GET admin/billing/overview', () => {
  it('分页与筛选范围统计独立于当前页，未开户用户也在列表里', async () => {
    const ids: bigint[] = [];
    for (let index = 0; index < 23; index += 1) {
      ids.push(
        await createUser(
          `${prefix}_${String(index).padStart(2, '0')}`,
          index === 0 ? '总览甲' : `总览${index}`,
        ),
      );
    }

    const first = await overview(`q=${prefix}&page=1&pageSize=10&sort=id_desc`);
    expect(first.total).toBe(23);
    expect(first.items).toHaveLength(10);
    expect(first.stats.userCount).toBe(23);
    expect(first.stats.pendingCount).toBe(23);
    expect(first.items.every((item) => item.status === 'pending')).toBe(true);
    expect(first.items.every((item) => item.period === first.period)).toBe(true);

    const second = await overview(`q=${prefix}&page=2&pageSize=10&sort=id_desc`);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((item) => item.userId)).size).toBe(20);
    expect(second.stats).toEqual(first.stats);

    const exact = await overview(`q=${ids[0]}&pageSize=10`);
    expect(exact.items.map((item) => item.userId)).toEqual([String(ids[0])]);
    expect(exact.items[0]).toMatchObject({
      status: 'pending',
      available: 0,
      limited: 0,
      lasting: 0,
    });
  });

  it('账本口径：已用、欠款、拆分与筛选', async () => {
    const normal = await createUser(`${prefix}_normal`, '正常用户');
    await grant(normal, 'limited', 500);
    await grant(normal, 'lasting', 1000);
    await charge(normal, [
      { bucket: 'limited', credits: 200 },
      { bucket: 'lasting', credits: 950 },
    ]);

    const debtor = await createUser(`${prefix}_debtor`, '欠款用户');
    await grant(debtor, 'lasting', 100);
    await charge(debtor, [{ bucket: 'lasting', credits: 250 }]);

    await createUser(`${prefix}_zero`, '零可用');
    const stale = await createUser(`${prefix}_stale`, '快照异常');
    await grant(stale, 'limited', 500);
    // 快照写坏：总览以账本为准，详情报告异常但不静默修库。
    await db().update(creditBalance).set({ available: 1 }).where(eq(creditBalance.userId, stale));

    const page = await overview(`q=${prefix}_&pageSize=100&sort=id_desc`);
    const byId = new Map(page.items.map((item) => [item.userId, item]));
    expect(byId.get(String(normal))).toMatchObject({
      userAccount: `${prefix}_normal`,
      userName: '正常用户',
      available: 350,
      limited: 300,
      lasting: 50,
      debt: 0,
      issued: 500,
      spent: 1150,
      status: 'granted',
    });
    expect(byId.get(String(debtor))).toMatchObject({
      available: -150,
      limited: 0,
      lasting: -150,
      debt: 150,
      status: 'pending',
    });
    expect(byId.get(String(stale))).toMatchObject({ available: 500, limited: 500 });

    const pending = await overview(`q=${prefix}&filter=pending&pageSize=100`);
    expect(pending.items.every((item) => item.status === 'pending')).toBe(true);
    expect(pending.items.some((item) => item.userId === String(normal))).toBe(false);

    const debt = await overview(`q=${prefix}&filter=debt&pageSize=100`);
    expect(debt.items.map((item) => item.userId)).toContain(String(debtor));
    expect(debt.stats.debtorCount).toBeGreaterThanOrEqual(1);
    expect(debt.stats.debtTotal).toBeGreaterThanOrEqual(150);

    const detail = await envelopeOf<AdminUserCreditDetail>(
      await billingRequest(`admin/billing/user/${stale}`, undefined, admin.cookie),
    );
    expect(detail.data.account.available).toBe(500);
    expect(detail.data.snapshotAnomaly).toBe(true);
  });

  it('支持账号/用户名模糊、完整 ID 精确搜索与可用额排序', async () => {
    const search = await billingRequest(
      `admin/billing/users?q=${prefix}_normal&limit=10`,
      undefined,
      admin.cookie,
    );
    const result = (await envelopeOf<AdminUserSearchResult>(search)).data;
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({
      userAccount: `${prefix}_normal`,
      userName: '正常用户',
    });

    const byName = (
      await envelopeOf<AdminUserSearchResult>(
        await billingRequest('admin/billing/users?q=正常用户&limit=10', undefined, admin.cookie),
      )
    ).data;
    expect(byName.users.some((user) => user.userAccount === `${prefix}_normal`)).toBe(true);

    const normal = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userAccount, `${prefix}_normal`))
      .limit(1);
    const byId = (
      await envelopeOf<AdminUserSearchResult>(
        await billingRequest(
          `admin/billing/users?q=${normal[0].id}&limit=10`,
          undefined,
          admin.cookie,
        ),
      )
    ).data;
    expect(byId.users).toHaveLength(1);
    expect(byId.users[0].userId).toBe(String(normal[0].id));

    const sorted = await overview(`q=${prefix}&sort=available_asc&pageSize=100`);
    const values = sorted.items.map((item) => item.available);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('浏览总览不写账本：账本行与快照数量保持不变', async () => {
    const beforeRows = await db()
      .select({ count: sql<string>`count(*)` })
      .from(creditLedger);
    const beforeSnapshots = await db()
      .select({ count: sql<string>`count(*)` })
      .from(creditBalance);
    await overview(`q=${prefix}&pageSize=100`);
    await overview(`q=${prefix}&pageSize=100&filter=pending`);
    expect(
      await db()
        .select({ count: sql<string>`count(*)` })
        .from(creditLedger),
    ).toEqual(beforeRows);
    expect(
      await db()
        .select({ count: sql<string>`count(*)` })
        .from(creditBalance),
    ).toEqual(beforeSnapshots);
  });
});
