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
import { db, getPool } from '@/server/infra/db';
import {
  creditBalance,
  creditLedger,
  creditQuotaPolicies,
  sessions,
  users,
} from '@/server/infra/schema';
import { ensurePeriodQuota, issuePendingQuota, ruleEntryOf } from '@/server/billing/quota';
import { balanceFactsOf } from '@/server/billing/expiry';
import { rebuildBalance } from '@/server/billing/ledger';
import { nextPeriodOf } from '@/server/billing/quota-policy';
import { nextPeriodStart, periodOf } from '@/server/billing/period';
import {
  monthlyQuotaCredits,
  type QuotaPolicyAdminView,
  type QuotaPolicySaveReceipt,
} from '@/shared/billing';

/**
 * C2 可配置月度配额：未来策略版本、用户覆盖/继承、0 配额、统一惰性发放与并发幂等。
 * 当前月份的规则不允许追溯修改；改当月只能在 C3 用单用户调整。
 */

const createdUsers: BillingTestUser[] = [];
const policyIds: string[] = [];
let admin: BillingTestUser;

const period = periodOf(new Date());
const nextPeriod = nextPeriodOf(period);
const nextAt = nextPeriodStart(new Date());

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('024_credit_ledger.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const userIds = [...createdUsers.map((user) => BigInt(user.id)), BigInt(admin.id)];
  if (policyIds.length)
    await db().delete(creditQuotaPolicies).where(inArray(creditQuotaPolicies.id, policyIds));
  await db().delete(creditQuotaPolicies).where(inArray(creditQuotaPolicies.createdBy, userIds));
  const scope = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await db().execute(sql`delete from credit_entry where charge_id in (
    select generation_id from credit_charge where user_id in (${scope}))`);
  await db().execute(sql`delete from credit_charge where user_id in (${scope})`);
  await db().delete(creditLedger).where(inArray(creditLedger.userId, userIds));
  await db().delete(creditBalance).where(inArray(creditBalance.userId, userIds));
  await db().delete(sessions).where(inArray(sessions.userId, userIds));
  await db().delete(users).where(inArray(users.id, userIds));
  await getPool().end();
});

async function newUser(): Promise<BillingTestUser> {
  const user = await createBillingUser();
  createdUsers.push(user);
  return user;
}

async function readPolicy(userId?: string): Promise<QuotaPolicyAdminView> {
  const response = await billingRequest(
    'admin/billing/quota/policy' + (userId ? `?userId=${encodeURIComponent(userId)}` : ''),
    undefined,
    admin.cookie,
  );
  expect(response.status).toBe(200);
  return (await envelopeOf<QuotaPolicyAdminView>(response)).data;
}

async function savePolicy(
  payload: Record<string, unknown>,
  session = admin.cookie,
): Promise<Response> {
  return billingRequest('admin/billing/quota/policy', payload, session);
}

async function savePolicyOk(payload: Record<string, unknown>): Promise<QuotaPolicySaveReceipt> {
  const response = await savePolicy(payload);
  expect(response.status).toBe(200);
  const receipt = (await envelopeOf<QuotaPolicySaveReceipt>(response)).data;
  policyIds.push(receipt.policy.id);
  return receipt;
}

async function rulesOf(userId: string, targetPeriod: string) {
  return db()
    .select()
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, BigInt(userId)),
        eq(creditLedger.kind, 'quota'),
        eq(creditLedger.origin, 'rule'),
        eq(creditLedger.period, targetPeriod),
      ),
    );
}

describe('月度配额策略版本', () => {
  it('默认仍是 500；保存下一账期策略不改当前账期，并用 expectedRevision 拦住覆盖', async () => {
    const initial = await readPolicy();
    expect(initial).toMatchObject({ period, nextPeriod, defaultCredits: monthlyQuotaCredits });
    expect(initial.global.current).toMatchObject({
      credits: monthlyQuotaCredits,
      source: 'fallback',
      version: null,
    });
    expect(initial.global.next).toMatchObject({
      credits: monthlyQuotaCredits,
      source: 'fallback',
      version: null,
    });

    const saved = await savePolicyOk({
      scope: 'global',
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 700,
      expectedRevision: null,
      note: '下一账期 700',
    });
    expect(saved.policy).toMatchObject({
      scope: 'global',
      effectivePeriod: nextPeriod,
      credits: 700,
      revision: 1,
    });
    expect(saved.effective).toMatchObject({ credits: 700, source: 'global', version: 1 });

    const view = await readPolicy();
    expect(view.global.current.credits).toBe(monthlyQuotaCredits);
    expect(view.global.next).toMatchObject({ credits: 700, source: 'global', version: 1 });
    expect(view.global.versions.some((version) => version.id === saved.policy.id)).toBe(true);

    // 同一账期已有 v1：不带 expectedRevision 的保存必须 409，不能静默覆盖。
    const stale = await savePolicy({
      scope: 'global',
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 800,
      expectedRevision: null,
    });
    expect(stale.status).toBe(409);
    const ok = await savePolicyOk({
      scope: 'global',
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 800,
      expectedRevision: 1,
    });
    expect(ok.policy.revision).toBe(2);

    // 过去/当前账期不可追溯修改；策略只从下个月或更晚生效。
    const current = await savePolicy({
      scope: 'global',
      effectivePeriod: period,
      mode: 'override',
      credits: 900,
      expectedRevision: null,
    });
    expect(current.status).toBe(400);
    const past = await savePolicy({
      scope: 'global',
      effectivePeriod: '2020-01',
      mode: 'override',
      credits: 900,
      expectedRevision: null,
    });
    expect(past.status).toBe(400);
  });

  it('用户覆盖与显式继承可区分；继承回落到全局，0 配额是真实覆盖', async () => {
    const user = await newUser();
    const override = await savePolicyOk({
      scope: 'user',
      userId: user.id,
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 0,
      expectedRevision: null,
      note: '零配额覆盖',
    });
    expect(override.policy).toMatchObject({
      scope: 'user',
      userId: user.id,
      credits: 0,
      revision: 1,
    });

    const zero = await readPolicy(user.id);
    expect(zero.user?.next).toMatchObject({ credits: 0, source: 'user', version: 1 });
    expect(zero.user?.current.credits).toBe(monthlyQuotaCredits);

    const inherit = await savePolicyOk({
      scope: 'user',
      userId: user.id,
      effectivePeriod: nextPeriod,
      mode: 'inherit',
      credits: null,
      expectedRevision: 1,
      note: '恢复全局',
    });
    expect(inherit.policy).toMatchObject({ mode: 'inherit', credits: null, revision: 2 });
    const inherited = await readPolicy(user.id);
    // 全局下一账期已被前一个用例改成 800；继承应读到它，而不是继续 0。
    expect(inherited.user?.next).toMatchObject({ credits: 800, source: 'global' });

    const forbidden = await savePolicy({
      scope: 'global',
      userId: user.id,
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 1,
      expectedRevision: 2,
    });
    expect(forbidden.status).toBe(400);
  });

  it('普通用户不能读写策略；不存在的用户 404', async () => {
    const plain = await newUser();
    expect(
      (await billingRequest('admin/billing/quota/policy', undefined, plain.cookie)).status,
    ).toBe(403);
    expect(
      (
        await savePolicy(
          {
            scope: 'global',
            effectivePeriod: nextPeriod,
            mode: 'override',
            credits: 1,
            expectedRevision: null,
          },
          plain.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await billingRequest('admin/billing/quota/policy?userId=999999999', undefined, admin.cookie))
        .status,
    ).toBe(404);
  });
});

describe('基础发放与 0 积分', () => {
  it('下一账期规则为 0 时写一条 0 积分回执行，不增加可用额；重复 ensure 不重复', async () => {
    const user = await newUser();
    await savePolicyOk({
      scope: 'global',
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 0,
      expectedRevision: 2,
      note: '下一账期 0',
    });

    const first = await ensurePeriodQuota(user.id, nextAt);
    expect(first).toMatchObject({ granted: true, period: nextPeriod, credits: 0 });
    expect((await rulesOf(user.id, nextPeriod))[0]).toMatchObject({ credits: 0, origin: 'rule' });

    const second = await ensurePeriodQuota(user.id, nextAt);
    expect(second).toMatchObject({ granted: false, period: nextPeriod, credits: 0 });
    expect(await rulesOf(user.id, nextPeriod)).toHaveLength(1);

    // 该账期没有可用额，但「已发」是事实。
    await rebuildBalance(user.id, nextAt);
    expect((await balanceFactsOf(user.id, nextAt)).available).toBe(0);
    expect(await ruleEntryOf(db(), BigInt(user.id), nextPeriod)).toMatchObject({ credits: 0 });
  });

  it('已有的规则行不会被后来的策略重新解释', async () => {
    const user = await newUser();
    const before = await rulesOf(user.id, period);
    expect(before).toHaveLength(1);
    expect(before[0].credits).toBe(monthlyQuotaCredits);

    // 改的是下一账期，不影响已发的当月。
    await savePolicyOk({
      scope: 'user',
      userId: user.id,
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 999,
      expectedRevision: null,
      note: '未来 999',
    });
    const result = await ensurePeriodQuota(user.id);
    expect(result).toMatchObject({ granted: false, credits: monthlyQuotaCredits });
    expect((await rulesOf(user.id, period))[0].credits).toBe(monthlyQuotaCredits);
  });

  it('并发 ensure 同一用户同一账期只落一行', async () => {
    const user = await newUser();
    const at = nextPeriodStart(new Date(nextAt.getTime() + 40 * 86_400_000));
    const target = periodOf(at);
    await savePolicyOk({
      scope: 'global',
      effectivePeriod: target,
      mode: 'override',
      credits: 300,
      expectedRevision: null,
      note: '并发用例：300',
    });
    const results = await Promise.all([
      ensurePeriodQuota(user.id, at),
      ensurePeriodQuota(user.id, at),
    ]);
    expect(results.filter((result) => result.granted)).toHaveLength(1);
    expect(await rulesOf(user.id, target)).toHaveLength(1);
  });

  it('批量补发按规则行去重：0 积分用户也算已处理，dry run 不写库', async () => {
    const zeroUser = await newUser();
    const paidUser = await newUser();
    await savePolicyOk({
      scope: 'user',
      userId: paidUser.id,
      effectivePeriod: nextPeriod,
      mode: 'override',
      credits: 120,
      expectedRevision: null,
      note: '批量用例：120',
    });

    const dryRun = await issuePendingQuota({
      at: nextAt,
      dryRun: true,
      userIds: [zeroUser.id, paidUser.id],
    });
    expect(dryRun).toMatchObject({ period: nextPeriod, dryRun: true, scanned: 2, issued: 0 });
    expect(await rulesOf(zeroUser.id, nextPeriod)).toHaveLength(0);

    const applied = await issuePendingQuota({ at: nextAt, userIds: [zeroUser.id, paidUser.id] });
    expect(applied).toMatchObject({
      period: nextPeriod,
      issued: 2,
      granted: 1,
      zero: 1,
      credits: 120,
    });
    expect((await rulesOf(zeroUser.id, nextPeriod))[0].credits).toBe(0);
    expect((await rulesOf(paidUser.id, nextPeriod))[0].credits).toBe(120);

    const rerun = await issuePendingQuota({ at: nextAt, userIds: [zeroUser.id, paidUser.id] });
    expect(rerun.scanned).toBe(0);
    expect(rerun.issued).toBe(0);
  });
});
