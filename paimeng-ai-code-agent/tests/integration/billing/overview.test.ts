import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { creditAccounts, creditGrants, creditQuotaIssues, sessions, users } from '@/server/infra/schema';
import type { AdminCreditOverview, AdminUserSearchResult, AdminUserUsage } from '@/shared/billing';

/**
 * C1 全用户额度总览：不需要当期发放也能看到用户；统计按筛选范围而不是当前页；
 * 浏览不写账本；没有 Credit 账户的用户同样在列表里。
 */

const prefix = 'overview_' + randomUUID().slice(0, 8);
const createdIds: bigint[] = [];
let admin: BillingTestUser;

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('010_credit_grant_account.sql', '012_credit_charge_entry.sql', '020_credit_quota_policy.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const ids = [...createdIds, BigInt(admin.id)];
  if (ids.length) {
    const scope = sql.join(ids.map(id => sql`${id}`), sql`, `);
    await db().execute(sql`delete from credit_entry
      where charge_id in (select generation_id from credit_charge where user_id in (${scope}))`);
    await db().execute(sql`delete from credit_charge where user_id in (${scope})`);
    await db().delete(creditQuotaIssues).where(inArray(creditQuotaIssues.userId, ids));
    await db().delete(creditGrants).where(inArray(creditGrants.userId, ids));
    await db().delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

/** 直接造用户，避免为总览用例付注册/登录的密码哈希成本。 */
async function createUser(account: string, userName: string | null): Promise<bigint> {
  const id = await nextSnowflakeId();
  createdIds.push(id);
  await db().insert(users).values({
    id, userAccount: account, userPassword: 'not-used', userName, userRole: 'user',
    createTime: now(), updateTime: now(),
  });
  return id;
}

async function grant(userId: bigint, pool: 'quota' | 'balance', credits: number, source: 'monthly_quota' | 'purchase' | 'admin_grant', period: string | null) {
  await db().insert(creditGrants).values({
    id: randomUUID(), userId, pool, credits, source, period, createTime: now(),
  });
  await db().insert(creditAccounts).values({ userId, pool, balance: credits, updateTime: now() })
    .onConflictDoUpdate({
      target: [creditAccounts.userId, creditAccounts.pool],
      set: { balance: sql`${creditAccounts.balance} + ${credits}`, updateTime: now() },
    });
}

/** 造一条 Charge 及其分池分录；create_time 决定配额归属账期。 */
async function charge(userId: bigint, entries: { pool: 'quota' | 'balance'; credits: number }[]) {
  const id = randomUUID();
  await db().execute(sql`insert into credit_charge
    (generation_id, app_id, user_id, credits, rate_card_snapshot, usage_snapshot, status, estimated_steps, create_time)
    values (${id}, 0, ${userId}, 0, '[]'::jsonb, '[]'::jsonb, 'settled', 0, ${now()})`);
  for (const entry of entries) {
    await db().execute(sql`insert into credit_entry (charge_id, pool, credits, create_time)
      values (${id}, ${entry.pool}, ${entry.credits}, ${now()})`);
    // 与 settlement 的 chargePools 一样同步余额快照；总览对账读快照只为了发现异常。
    const [account] = await db().select().from(creditAccounts)
      .where(and(eq(creditAccounts.userId, userId), eq(creditAccounts.pool, entry.pool))).limit(1);
    const next = (account?.balance ?? 0) - entry.credits;
    await db().insert(creditAccounts).values({ userId, pool: entry.pool, balance: next, updateTime: now() })
      .onConflictDoUpdate({
        target: [creditAccounts.userId, creditAccounts.pool],
        set: { balance: next, updateTime: now() },
      });
  }
}

async function overview(query = '') {
  const response = await billingRequest(`admin/billing/overview?${query}`, undefined, admin.cookie);
  expect(response.status).toBe(200);
  return (await envelopeOf<AdminCreditOverview>(response)).data;
}

describe('GET admin/billing/overview', () => {
  it('全库分页与筛选范围统计独立于当前页，未开户用户也在列表里', async () => {
    const ids: bigint[] = [];
    for (let index = 0; index < 23; index += 1) {
      ids.push(await createUser(`${prefix}_${String(index).padStart(2, '0')}`, index === 0 ? '总览甲' : `总览${index}`));
    }

    const first = await overview(`q=${prefix}&page=1&pageSize=10&sort=id_desc`);
    expect(first.total).toBe(23);
    expect(first.items).toHaveLength(10);
    expect(first.stats.userCount).toBe(23);
    expect(first.stats.pendingCount).toBe(23);
    expect(first.items.every(item => item.issueStatus === 'pending')).toBe(true);
    expect(first.items.every(item => item.period === first.period)).toBe(true);

    const second = await overview(`q=${prefix}&page=2&pageSize=10&sort=id_desc`);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map(item => item.userId)).size).toBe(20);
    expect(second.stats).toEqual(first.stats);

    // 无发放、无账户记录的用户也必须能被完整 ID 精确搜到。
    const exact = await overview(`q=${ids[0]}&pageSize=10`);
    expect(exact.items.map(item => item.userId)).toEqual([String(ids[0])]);
    expect(exact.items[0]).toMatchObject({ issueStatus: 'pending', quotaBase: 0, balance: 0 });
  });

  it('配额与余额按账本事实计算：已用、欠款、合计、快照异常分开表达', async () => {
    const normal = await createUser(`${prefix}_normal`, '正常用户');
    await grant(normal, 'quota', 500, 'monthly_quota', '2026-11');
    await grant(normal, 'balance', 1000, 'purchase', null);
    await charge(normal, [{ pool: 'quota', credits: 200 }, { pool: 'balance', credits: 950 }]);

    const debtor = await createUser(`${prefix}_debtor`, '欠款用户');
    await grant(debtor, 'balance', 100, 'admin_grant', null);
    await charge(debtor, [{ pool: 'balance', credits: 250 }]);

    const zero = await createUser(`${prefix}_zero`, '零可用');
    const stale = await createUser(`${prefix}_stale`, '快照异常');
    await grant(stale, 'quota', 500, 'monthly_quota', '2026-11');

    // 造一条与事实不一致的配额快照：总览只报告，不静默改库。
    await db().update(creditAccounts).set({ balance: 1 })
      .where(and(eq(creditAccounts.userId, stale), eq(creditAccounts.pool, 'quota')));

    const page = await overview(`q=${prefix}_&pageSize=100&sort=id_desc`);
    const byId = new Map(page.items.map(item => [item.userId, item]));
    expect(byId.get(String(normal))).toMatchObject({
      userAccount: `${prefix}_normal`, userName: '正常用户',
      quotaBase: 500, quotaAdjustments: 0, quotaUsed: 200, quotaRemaining: 300,
      balance: 50, total: 350, debt: 0, issueStatus: 'granted', policySource: 'legacy',
      snapshotAnomaly: false,
    });
    expect(byId.get(String(debtor))).toMatchObject({
      quotaRemaining: 0, balance: -150, total: -150, debt: 150, issueStatus: 'pending',
    });
    expect(byId.get(String(zero))).toMatchObject({ balance: 0, total: 0, quotaRemaining: 0 });
    expect(byId.get(String(stale))).toMatchObject({ snapshotAnomaly: true, quotaRemaining: 500, total: 500 });

    const pending = await overview(`q=${prefix}&filter=pending&pageSize=100`);
    expect(pending.items.every(item => item.issueStatus === 'pending')).toBe(true);
    expect(pending.items.some(item => item.userId === String(normal))).toBe(false);

    const debt = await overview(`q=${prefix}&filter=debt&pageSize=100`);
    expect(debt.items.map(item => item.userId)).toContain(String(debtor));
    expect(debt.stats.debtorCount).toBeGreaterThanOrEqual(1);
    expect(debt.stats.debtTotal).toBeGreaterThanOrEqual(150);

    const zeroFilter = await overview(`q=${prefix}&filter=zero&pageSize=100`);
    expect(zeroFilter.items.map(item => item.userId)).toContain(String(zero));
  });

  it('支持账号/用户名模糊、完整 ID 精确搜索与余额排序', async () => {
    const search = await billingRequest(`admin/billing/users?q=${prefix}_normal&limit=10`, undefined, admin.cookie);
    const result = (await envelopeOf<AdminUserSearchResult>(search)).data;
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({ userAccount: `${prefix}_normal`, userName: '正常用户' });

    const byName = (await envelopeOf<AdminUserSearchResult>(
      await billingRequest(`admin/billing/users?q=正常用户&limit=10`, undefined, admin.cookie),
    )).data;
    expect(byName.users.some(user => user.userAccount === `${prefix}_normal`)).toBe(true);

    const normal = await db().select({ id: users.id }).from(users)
      .where(eq(users.userAccount, `${prefix}_normal`)).limit(1);
    const byId = (await envelopeOf<AdminUserSearchResult>(
      await billingRequest(`admin/billing/users?q=${normal[0].id}&limit=10`, undefined, admin.cookie),
    )).data;
    expect(byId.users).toHaveLength(1);
    expect(byId.users[0].userId).toBe(String(normal[0].id));

    const sorted = await overview(`q=${prefix}&sort=balance_asc&pageSize=100`);
    const balances = sorted.items.map(item => item.balance);
    expect(balances).toEqual([...balances].sort((a, b) => a - b));
  });

  it('浏览总览与详情不写账本：grant、entry 数量保持不变', async () => {
    const beforeGrants = await db().select({ count: sql<string>`count(*)` }).from(creditGrants);
    const beforeEntries = await db().execute(sql`select count(*) as count from credit_entry`);
    await overview(`q=${prefix}&pageSize=100`);
    await overview(`q=${prefix}&pageSize=100&filter=pending`);
    const user = await db().select({ id: users.id }).from(users)
      .where(eq(users.userAccount, `${prefix}_normal`)).limit(1);
    const detail = await billingRequest(`admin/billing/usage?userId=${user[0].id}`, undefined, admin.cookie);
    expect(detail.status).toBe(200);
    const afterGrants = await db().select({ count: sql<string>`count(*)` }).from(creditGrants);
    const afterEntries = await db().execute(sql`select count(*) as count from credit_entry`);
    expect(afterGrants[0].count).toBe(beforeGrants[0].count);
    expect(afterEntries.rows[0].count).toBe(beforeEntries.rows[0].count);
  });

  it('普通用户不能读全用户总览与用户搜索', async () => {
    const plain = await createBillingUser();
    try {
      const overviewDenied = await billingRequest(`admin/billing/overview?q=${prefix}`, undefined, plain.cookie);
      const searchDenied = await billingRequest(`admin/billing/users?q=${prefix}`, undefined, plain.cookie);
      expect(overviewDenied.status).toBe(403);
      expect(searchDenied.status).toBe(403);
    } finally {
      await db().delete(creditGrants).where(eq(creditGrants.userId, BigInt(plain.id)));
      await db().delete(creditAccounts).where(eq(creditAccounts.userId, BigInt(plain.id)));
      await db().delete(sessions).where(eq(sessions.userId, BigInt(plain.id)));
      await db().delete(users).where(eq(users.id, BigInt(plain.id)));
    }
  });
});
