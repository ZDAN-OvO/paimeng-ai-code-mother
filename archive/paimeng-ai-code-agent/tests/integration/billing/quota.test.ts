import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import { creditBalance, creditLedger, sessions, users } from '@/server/infra/schema';
import { naiveTime, nextPeriodStart, periodOf, periodRange } from '@/server/billing/period';
import {
  ensureCurrentPeriod,
  ensurePeriodQuota,
  issuePendingQuota,
  ruleEntryOf,
} from '@/server/billing/quota';
import { balanceFactsOf, ensureExpiry } from '@/server/billing/expiry';
import { rebuildBalance } from '@/server/billing/ledger';
import { monthlyQuotaCredits, type AccountSummary } from '@/shared/billing';

/**
 * 每月限时积分：北京时间自然月、规则一行、幂等、不结转。
 * 触发点是注册、读取摘要与批量补发（无常驻定时器）。
 */

const created: BillingTestUser[] = [];

const createUser = async () => {
  const user = await createBillingUser();
  created.push(user);
  return user;
};

const idOf = (user: BillingTestUser) => BigInt(user.id);

async function ruleRowsOf(user: BillingTestUser) {
  return db()
    .select()
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, idOf(user)),
        eq(creditLedger.kind, 'quota'),
        eq(creditLedger.origin, 'rule'),
      ),
    )
    .orderBy(asc(creditLedger.period));
}

async function summaryOf(user: BillingTestUser): Promise<AccountSummary> {
  const response = await envelopeOf<AccountSummary>(
    await billingRequest('billing/summary', undefined, user.cookie),
  );
  expect(response.code).toBe(0);
  return response.data;
}

async function removeCurrentRule(user: BillingTestUser, period: string) {
  await db()
    .delete(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, idOf(user)),
        eq(creditLedger.kind, 'quota'),
        eq(creditLedger.origin, 'rule'),
        eq(creditLedger.period, period),
      ),
    );
  await rebuildBalance(user.id);
}

/** 造一条真实 Charge 与它的消费/退回行（consume/refund 必须有 charge_id）。 */
async function seedChargeRows(
  user: BillingTestUser,
  input: {
    credits: number;
    period: string;
    at: string;
    kind?: 'consume' | 'refund';
  },
): Promise<string> {
  const id = randomUUID();
  await db().execute(sql`insert into credit_charge
    (generation_id, app_id, user_id, credits, rate_card_snapshot, usage_snapshot, status, estimated_steps, create_time)
    values (${id}, 0, ${idOf(user)}, 0, '[]'::jsonb, '[]'::jsonb, 'reversed', 0, ${input.at})`);
  await db()
    .insert(creditLedger)
    .values({
      userId: idOf(user),
      kind: input.kind ?? 'consume',
      origin: 'charge',
      credits: input.kind === 'refund' ? -input.credits : input.credits,
      period: input.period,
      expiresAt: naiveTime(periodRange(input.period).end),
      chargeId: id,
      createTime: input.at,
    });
  return id;
}

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('024_credit_ledger.sql');
});

afterAll(async () => {
  const ids = created.map(idOf);
  if (ids.length > 0) {
    const scope = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await db().execute(
      sql`delete from credit_ledger where charge_id in (select generation_id from credit_charge where user_id in (${scope}))`,
    );
    await db().execute(sql`delete from credit_charge where user_id in (${scope})`);
    await db().delete(creditLedger).where(inArray(creditLedger.userId, ids));
    await db().delete(creditBalance).where(inArray(creditBalance.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

describe('每月限时积分', () => {
  it('注册即得当期 500，摘要带出账期与北京时间到期时刻', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    const summary = await summaryOf(user);
    expect(summary).toMatchObject({
      limited: monthlyQuotaCredits,
      lasting: 0,
      available: monthlyQuotaCredits,
      period,
    });
    expect(summary.limitedExpiresAt?.slice(0, 19)).toBe(
      naiveTime(periodRange(period).end).slice(0, 19),
    );

    const rows = await ruleRowsOf(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credits: monthlyQuotaCredits, period, origin: 'rule' });
  });

  it('重复 ensure 同一账期只有一行，余额不翻倍', async () => {
    const user = await createUser();
    const at = new Date();
    expect(await ensurePeriodQuota(user.id, at)).toMatchObject({
      granted: false,
      period: periodOf(at),
    });
    expect(await ruleRowsOf(user)).toHaveLength(1);
    expect((await balanceFactsOf(user.id)).available).toBe(monthlyQuotaCredits);
  });

  it('并发 ensure 下一账期也只落一行', async () => {
    const user = await createUser();
    const at = nextPeriodStart(new Date());
    const results = await Promise.all([
      ensurePeriodQuota(user.id, at),
      ensurePeriodQuota(user.id, at),
    ]);
    expect(results.filter((result) => result.granted)).toHaveLength(1);
    expect((await ruleRowsOf(user)).filter((row) => row.period === periodOf(at))).toHaveLength(1);
    expect((await balanceFactsOf(user.id, at)).limited).toBe(monthlyQuotaCredits);
  });

  it('换月不结转：上月剩余写一条过期行，新账期重新发 500', async () => {
    const user = await createUser();
    // 当期消费 200，只剩 300。
    const period = periodOf(new Date());
    await seedChargeRows(user, { credits: -200, period, at: naiveTime(new Date()) });
    await rebuildBalance(user.id);

    const nextAt = nextPeriodStart(new Date());
    const summary = await ensureCurrentPeriod(user.id, nextAt);
    expect(summary.period).toBe(periodOf(nextAt));
    expect(summary.limited).toBe(monthlyQuotaCredits);

    const expired = await db()
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, idOf(user)),
          eq(creditLedger.kind, 'expire'),
          eq(creditLedger.period, period),
        ),
      );
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ origin: 'expiry', credits: -300 });
    expect((await ruleRowsOf(user)).map((row) => row.period)).toEqual([period, periodOf(nextAt)]);
  });

  it('扫过期是幂等的：再调一次不写第二条', async () => {
    const user = await createUser();
    const nextAt = nextPeriodStart(new Date());
    await ensureExpiry(user.id, nextAt);
    const first = (
      await db()
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, idOf(user)), eq(creditLedger.kind, 'expire')))
    ).length;
    await ensureExpiry(user.id, nextAt);
    const second = (
      await db()
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, idOf(user)), eq(creditLedger.kind, 'expire')))
    ).length;
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('读摘要会补发停机错过的当月规则，重复读取不再加', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    await removeCurrentRule(user, period);

    const first = await summaryOf(user);
    expect(first).toMatchObject({ period, limited: monthlyQuotaCredits });
    const second = await summaryOf(user);
    expect(second.limited).toBe(monthlyQuotaCredits);
    expect(await ruleRowsOf(user)).toHaveLength(1);
  });

  it('批量补发：dry-run 不写库，apply 才写；0 积分也有回执行', async () => {
    const zero = await createUser();
    const period = periodOf(new Date());
    await removeCurrentRule(zero, period);
    // 规则为 0：写一条 credits=0 的规则行，之后不会每次都被扫到。
    await db()
      .insert(creditLedger)
      .values({
        userId: idOf(zero),
        kind: 'quota',
        origin: 'rule',
        credits: 0,
        period,
        expiresAt: naiveTime(periodRange(period).end),
        reason: '暂停发放',
        createTime: naiveTime(new Date()),
      });
    await rebuildBalance(zero.id);

    const normal = await createUser();
    await removeCurrentRule(normal, period);

    const dryRun = await issuePendingQuota({ dryRun: true, userIds: [normal.id] });
    expect(dryRun).toMatchObject({ period, dryRun: true, scanned: 1, issued: 0 });
    expect(await ruleRowsOf(normal)).toHaveLength(0);

    const applied = await issuePendingQuota({ userIds: [normal.id] });
    expect(applied).toMatchObject({
      period,
      scanned: 1,
      issued: 1,
      granted: 1,
      zero: 0,
      credits: monthlyQuotaCredits,
    });
    expect(applied.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await ruleRowsOf(normal))[0]?.period).toBe(period);

    // 0 积分用户已有规则行，不会进入待发名单。
    const zeroRun = await issuePendingQuota({ dryRun: true, userIds: [zero.id] });
    expect(zeroRun.scanned).toBe(0);
  });
});

describe('账期归属', () => {
  it('旧账期的消费与冲正留在旧账期，不让过期额度复活', async () => {
    const user = await createUser();
    const oldPeriod = '2020-03';
    const end = naiveTime(periodRange(oldPeriod).end);
    await db()
      .insert(creditLedger)
      .values({
        userId: idOf(user),
        kind: 'quota',
        origin: 'manual',
        credits: 100,
        period: oldPeriod,
        expiresAt: end,
        createTime: '2020-03-01 00:00:00.000',
      });
    const chargeId = await seedChargeRows(user, {
      credits: -100,
      period: oldPeriod,
      at: '2020-03-15 04:00:00.000',
    });
    await db()
      .insert(creditLedger)
      .values([
        {
          userId: idOf(user),
          kind: 'refund',
          origin: 'reversal',
          credits: 100,
          period: oldPeriod,
          expiresAt: end,
          chargeId,
          createTime: '2020-04-01 04:00:00.000',
        },
        {
          userId: idOf(user),
          kind: 'expire',
          origin: 'reversal',
          credits: -100,
          period: oldPeriod,
          expiresAt: end,
          createTime: '2020-04-01 04:00:00.000',
        },
      ]);
    await rebuildBalance(user.id);

    const summary = await ensureCurrentPeriod(user.id, nextPeriodStart(new Date()));
    expect(summary.limited).toBe(monthlyQuotaCredits);
    // 旧账期净额为 0，不产生额外的过期行。
    const oldExpire = await db()
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, idOf(user)),
          eq(creditLedger.kind, 'expire'),
          eq(creditLedger.period, oldPeriod),
          eq(creditLedger.origin, 'expiry'),
        ),
      );
    expect(oldExpire).toHaveLength(0);
  });

  it('当期消费从限时积分扣，下一次规则发放前就少了', async () => {
    const user = await createUser();
    const period = periodOf(new Date());
    await seedChargeRows(user, { credits: -100, period, at: naiveTime(new Date()) });
    await rebuildBalance(user.id);

    expect((await summaryOf(user)).limited).toBe(monthlyQuotaCredits - 100);
    expect((await ruleEntryOf(db(), idOf(user), period))?.credits).toBe(monthlyQuotaCredits);
  });
});
