import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingRequest, createBillingUser, envelopeOf, loadBillingDatabase,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import { creditBalance, creditLedger, sessions, users } from '@/server/infra/schema';
import { ensureExpiry, sweepExpiry } from '@/server/billing/expiry';
import { rebuildBalance } from '@/server/billing/ledger';
import { naiveTime, periodRange } from '@/server/billing/period';
import { randomUUID } from 'node:crypto';
import { creditCharges } from '@/server/infra/schema';
import type { AdminCreditOverview } from '@/shared/billing';

/**
 * 过期写入与读修正：即使扫描没跑，列表也不能多算；跑过之后只写一条，且余额与账本一致。
 */

const created: BillingTestUser[] = [];
let admin: BillingTestUser;

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('024_credit_ledger.sql');
  admin = await createBillingUser({ role: 'admin' });
});

afterAll(async () => {
  const ids = [BigInt(admin.id), ...created.map(user => BigInt(user.id))];
  await db().delete(creditLedger).where(inArray(creditLedger.userId, ids));
  await db().delete(creditBalance).where(inArray(creditBalance.userId, ids));
  await db().delete(sessions).where(inArray(sessions.userId, ids));
  await db().delete(users).where(inArray(users.id, ids));
  await getPool().end();
});

async function newUser(account: string): Promise<BillingTestUser> {
  const user = await createBillingUser();
  created.push(user);
  await db().update(users).set({ userAccount: `expiry_${account}_${user.id}` }).where(eq(users.id, BigInt(user.id)));
  return user;
}

/** 造一条 Charge 与它的消费行（consume 必须有 charge_id）。 */
async function seedConsume(userId: bigint, period: string, used: number): Promise<string> {
  const chargeId = randomUUID();
  await db().insert(creditCharges).values({
    generationId: chargeId, appId: 0n, userId, credits: used, costUsd: null,
    rateCardSnapshot: [], usageSnapshot: [], status: 'settled', estimatedSteps: 0,
    createTime: `${period}-15 00:00:00.000`,
  });
  await db().insert(creditLedger).values({
    userId, kind: 'consume', origin: 'charge', credits: -used, period,
    expiresAt: naiveTime(periodRange(period).end), chargeId, createTime: `${period}-15 00:00:00.000`,
  });
  return chargeId;
}

/** 造一个已结束账期的发放与消费（不写过期行）。 */
async function seedPastPeriod(user: BillingTestUser, period: string, issued: number, used: number) {
  const end = naiveTime(periodRange(period).end);
  await db().delete(creditLedger).where(eq(creditLedger.userId, BigInt(user.id)));
  await db().insert(creditLedger).values({
    userId: BigInt(user.id), kind: 'quota', origin: 'rule', credits: issued, period, expiresAt: end,
    createTime: `${period}-01 00:00:00.000`,
  });
  if (used > 0) await seedConsume(BigInt(user.id), period, used);
}

async function overviewOf(user: BillingTestUser) {
  const response = await billingRequest(
    `admin/billing/overview?q=${user.id}&pageSize=10`, undefined, admin.cookie,
  );
  expect(response.status).toBe(200);
  return (await envelopeOf<AdminCreditOverview>(response)).data;
}

describe('过期写入与读修正', () => {
  it('扫描没跑时，列表按未写出的余量扣减，不多算', async () => {
    const user = await newUser('pending');
    await seedPastPeriod(user, '2020-01', 500, 200);

    const before = await overviewOf(user);
    const item = before.items.find(row => row.userId === user.id);
    // 原始账本 = 300（还没写过期行），读修正把它扣成 0。
    expect(item).toMatchObject({ available: 0, limited: 0, lasting: 0 });
  });

  it('ensureExpiry 只写一条，金额等于发放 − 消费；重复调用不重复写', async () => {
    const user = await newUser('ensure');
    await seedPastPeriod(user, '2020-01', 500, 200);

    expect(await ensureExpiry(user.id)).toBe(1);
    const rows = await db().select().from(creditLedger).where(and(
      eq(creditLedger.userId, BigInt(user.id)), eq(creditLedger.kind, 'expire'),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credits: -300, period: '2020-01', origin: 'expiry' });
    expect(await ensureExpiry(user.id)).toBe(0);

    const after = await overviewOf(user);
    expect(after.items.find(row => row.userId === user.id)?.available).toBe(0);
  });

  it('全库扫描：多用户多账期各写一条，余额与账本求和一致', async () => {
    const first = await newUser('sweep-a');
    const second = await newUser('sweep-b');
    await db().delete(creditLedger).where(inArray(creditLedger.userId, [BigInt(first.id), BigInt(second.id)]));
    for (const [user, period, issued, used] of [
      [first, '2020-01', 500, 0], [first, '2020-02', 400, 100], [second, '2020-01', 300, 300],
    ] as const) {
      const end = naiveTime(periodRange(period).end);
      await db().insert(creditLedger).values({
        userId: BigInt(user.id), kind: 'quota', origin: 'rule', credits: issued, period, expiresAt: end,
        createTime: `${period}-01 00:00:00.000`,
      });
      if (used) await seedConsume(BigInt(user.id), period, used);
    }

    const run = await sweepExpiry(new Date());
    expect(run.users).toBeGreaterThanOrEqual(2);
    expect(run.entries).toBeGreaterThanOrEqual(2);

    const firstExpired = await db().select().from(creditLedger).where(and(
      eq(creditLedger.userId, BigInt(first.id)), eq(creditLedger.kind, 'expire'),
    ));
    expect(firstExpired.map(row => row.credits).sort()).toEqual([-300, -500]);
    // 第二个人刚好用完，不写 0 金额的过期行。
    expect(await db().select().from(creditLedger).where(and(
      eq(creditLedger.userId, BigInt(second.id)), eq(creditLedger.kind, 'expire'),
    ))).toHaveLength(0);

    const [snapshot] = await db().select().from(creditBalance).where(eq(creditBalance.userId, BigInt(first.id)));
    expect(snapshot.available).toBe(0);
  });
});
