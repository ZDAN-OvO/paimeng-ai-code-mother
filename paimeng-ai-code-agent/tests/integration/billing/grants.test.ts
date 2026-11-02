import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyBillingMigrations, billingRequest, createBillingUser, envelopeOf, loadBillingDatabase, seedLedgerEntry,
  withoutMonthlyQuota, type BillingTestUser,
} from '../../support/billing';
import { db, getPool } from '@/server/infra/db';
import { creditBalance, creditLedger, sessions, users } from '@/server/infra/schema';
import { issueCredits } from '@/server/billing/admin';
import { accountSnapshot, auditBalance, rebuildBalance } from '@/server/billing/ledger';
import { ensureCurrentPeriod } from '@/server/billing/quota';
import { naiveTime, periodOf, periodRange } from '@/server/billing/period';

/**
 * 发放与余额口径：账本行、账期、幂等、批量摘要、事务原子性、近 60 天窗口与 HTTP 权限。
 * 扣减与跨期过期在 settlement / expiry 用例里。
 */

const createdUsers: string[] = [];

beforeAll(async () => {
  await applyBillingMigrations('024_credit_ledger.sql');
});

afterAll(async () => {
  if (createdUsers.length) {
    const ids = createdUsers.map(id => BigInt(id));
    await db().delete(creditLedger).where(inArray(creditLedger.userId, ids));
    await db().delete(creditBalance).where(inArray(creditBalance.userId, ids));
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

async function newUser(role?: 'user' | 'admin'): Promise<BillingTestUser> {
  loadBillingDatabase();
  const user = await createBillingUser({ role });
  createdUsers.push(user.id);
  return user;
}

async function nameRows(userId: string) {
  return db().select().from(creditLedger).where(eq(creditLedger.userId, BigInt(userId)))
    .orderBy(creditLedger.id);
}

function daysAgo(days: number): string {
  return naiveTime(new Date(Date.now() - days * 86_400_000));
}

async function summaryOf(session: string) {
  const envelope = await envelopeOf<{ available: number; limited: number; lasting: number; period: string }>(
    await billingRequest('billing/summary', undefined, session),
  );
  expect(envelope.code).toBe(0);
  return envelope.data;
}

const currentPeriod = () => periodOf(new Date());

describe('积分发放与余额口径', () => {
  it('发放长期积分：账本只有一行，可用额与两种口径同步', async () => {
    const admin = await newUser('admin');
    const owner = await withoutMonthlyQuota(await newUser());
    const requestId = randomUUID();
    const receipt = await issueCredits({
      userId: owner.id, kind: 'lasting', credits: 300, reason: '首充', requestId, operatorId: admin.id,
    });
    expect(receipt).toMatchObject({ created: 1, credits: 300, failures: [], operationId: null });

    const rows = await nameRows(owner.id);
    const manual = rows.filter(row => row.origin === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      kind: 'grant', origin: 'manual', credits: 300, period: null, expiresAt: null,
      reason: '首充', operatorId: BigInt(admin.id), requestId,
    });
    expect(await accountSnapshot(owner.id)).toMatchObject({
      limited: 0, lasting: 300, available: 300,
    });
  });

  it('限时积分落在当前账期，到期时刻是北京时间下月 1 号 00:00', async () => {
    await newUser('admin');
    const owner = await withoutMonthlyQuota(await newUser());
    const before = await accountSnapshot(owner.id);
    const receipt = await issueCredits({
      userId: owner.id, kind: 'limited', credits: 120, reason: '补偿', requestId: randomUUID(), operatorId: owner.id,
    });
    const rows = await nameRows(owner.id);
    const manual = rows.find(row => row.origin === 'manual');
    expect(manual).toMatchObject({ kind: 'quota', period: currentPeriod(), credits: 120 });
    expect(manual?.expiresAt?.slice(0, 19)).toBe(naiveTime(periodRange(currentPeriod()).end).slice(0, 19));
    expect(receipt.created).toBe(1);
    const after = await accountSnapshot(owner.id);
    expect(after.available).toBe(before.available + 120);
  });

  it('同一 requestId 重复提交只入账一次', async () => {
    await newUser('admin');
    const owner = await newUser();
    const requestId = randomUUID();
    const first = await issueCredits({ userId: owner.id, kind: 'lasting', credits: 50, reason: '测试', requestId, operatorId: owner.id });
    const second = await issueCredits({ userId: owner.id, kind: 'lasting', credits: 50, reason: '测试', requestId, operatorId: owner.id });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect((await nameRows(owner.id)).filter(row => row.origin === 'manual')).toHaveLength(1);
  });

  it('并发使用同一 requestId：只写一行', async () => {
    await newUser('admin');
    const owner = await newUser();
    const requestId = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      issueCredits({ userId: owner.id, kind: 'lasting', credits: 100, reason: '并发', requestId, operatorId: owner.id })));
    expect(results.reduce((sum, item) => sum + item.created, 0)).toBe(1);
    expect((await nameRows(owner.id)).filter(row => row.requestId === requestId)).toHaveLength(1);
  });

  it('批量发放：每人一行，汇总写一条操作日志', async () => {
    const admin = await newUser('admin');
    const users2 = [await newUser(), await newUser()];
    const requestId = randomUUID();
    const receipt = await issueCredits({
      userIds: users2.map(user => user.id), kind: 'lasting', credits: 60, reason: '活动', requestId, operatorId: admin.id,
    });
    expect(receipt).toMatchObject({ created: 2, credits: 120, failures: [] });
    expect(receipt.operationId).toMatch(/^[0-9a-f-]{36}$/);
    for (const user of users2) {
      expect((await nameRows(user.id)).filter(row => row.kind === 'grant')).toHaveLength(1);
    }
    const list = await envelopeOf<{ operations: { id: string; issuedCount: number; credits: number }[] }>(
      await billingRequest('admin/billing/operations?limit=5', undefined, admin.cookie),
    );
    expect(list.data.operations[0]).toMatchObject({ id: receipt.operationId, issuedCount: 2, credits: 120 });
  });

  it('余额快照写失败时整笔回滚，不留半条账本行', async () => {
    await newUser('admin');
    const owner = await withoutMonthlyQuota(await newUser());
    await getPool().query(
      "CREATE OR REPLACE FUNCTION billing_test_reject_balance() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'billing test: 拒绝写余额快照'; END; $fn$ LANGUAGE plpgsql",
    );
    await getPool().query(
      `CREATE TRIGGER billing_test_reject_balance BEFORE INSERT OR UPDATE ON credit_balance FOR EACH ROW WHEN (NEW.user_id = ${BigInt(owner.id)}) EXECUTE FUNCTION billing_test_reject_balance()`,
    );
    try {
      await expect(issueCredits({
        userId: owner.id, kind: 'lasting', credits: 999, reason: '注入失败', requestId: randomUUID(), operatorId: owner.id,
      })).rejects.toThrow();
    } finally {
      await getPool().query('DROP TRIGGER IF EXISTS billing_test_reject_balance ON credit_balance');
      await getPool().query('DROP FUNCTION IF EXISTS billing_test_reject_balance()');
    }
    expect((await nameRows(owner.id)).filter(row => row.origin === 'manual')).toHaveLength(0);
    expect((await accountSnapshot(owner.id)).available).toBe(0);
  });

  it('余额快照可以只由账本重建', async () => {
    const owner = await newUser();
    await db().delete(creditBalance).where(eq(creditBalance.userId, BigInt(owner.id)));
    const facts = await rebuildBalance(owner.id);
    expect(facts.available).toBe(500);
    expect((await auditBalance(owner.id)).diff).toBe(0);
  });

  it('近 60 天窗口：59 天前计入、61 天前不计入、补偿不计入', async () => {
    const owner = await newUser();
    await seedLedgerEntry({ userId: owner.id, kind: 'topup', origin: 'payment', credits: 100, createTime: daysAgo(59) });
    await seedLedgerEntry({ userId: owner.id, kind: 'topup', origin: 'payment', credits: 1000, createTime: daysAgo(61) });
    await seedLedgerEntry({ userId: owner.id, kind: 'grant', origin: 'manual', credits: 500, createTime: daysAgo(1) });
    expect(await accountSnapshot(owner.id)).toMatchObject({ purchasedCredits60d: 100, overdraft: 2 });
  });

  it('透支线只由充值推导：无充值为 0、1000 为 20、100000 为 500', async () => {
    const none = await newUser();
    await seedLedgerEntry({ userId: none.id, kind: 'grant', origin: 'manual', credits: 100_000, createTime: daysAgo(1) });
    expect(await accountSnapshot(none.id)).toMatchObject({ purchasedCredits60d: 0, overdraft: 0 });

    const small = await newUser();
    await seedLedgerEntry({ userId: small.id, kind: 'topup', origin: 'payment', credits: 1000, createTime: daysAgo(1) });
    expect(await accountSnapshot(small.id)).toMatchObject({ purchasedCredits60d: 1000, overdraft: 20 });

    const big = await newUser();
    await seedLedgerEntry({ userId: big.id, kind: 'topup', origin: 'payment', credits: 100_000, createTime: daysAgo(1) });
    expect(await accountSnapshot(big.id)).toMatchObject({ purchasedCredits60d: 100_000, overdraft: 500 });
  });

  it('HTTP：未登录 401、普通用户 403、管理员发放成功且重放不重复', async () => {
    const admin = await newUser('admin');
    const owner = await newUser();
    const body = { userId: owner.id, kind: 'lasting', credits: 260, reason: '后台发放', requestId: randomUUID() };

    expect((await billingRequest('admin/billing/issue', body)).status).toBe(401);
    expect((await billingRequest('admin/billing/issue', body, owner.cookie)).status).toBe(403);

    const granted = await envelopeOf<{ created: number; credits: number }>(
      await billingRequest('admin/billing/issue', body, admin.cookie),
    );
    expect(granted.code).toBe(0);
    expect(granted.data).toMatchObject({ created: 1, credits: 260 });

    const replay = await envelopeOf<{ created: number }>(await billingRequest('admin/billing/issue', body, admin.cookie));
    expect(replay.data.created).toBe(0);
    expect((await nameRows(owner.id)).filter(row => row.origin === 'manual')).toHaveLength(1);
  });

  it('HTTP：发放参数越界与用户不存在被拒绝', async () => {
    const admin = await newUser('admin');
    const owner = await newUser();
    const base = { userId: owner.id, kind: 'lasting', credits: 100, reason: '测试', requestId: randomUUID() };
    const post = (body: unknown) => billingRequest('admin/billing/issue', body, admin.cookie);

    expect((await post({ ...base, credits: 0 })).status).toBe(400);
    expect((await post({ ...base, credits: 1_000_001 })).status).toBe(400);
    expect((await post({ ...base, credits: 1.5 })).status).toBe(400);
    expect((await post({ ...base, reason: '' })).status).toBe(400);
    expect((await post({ ...base, userId: undefined })).status).toBe(400);
    expect((await post({ ...base, userId: '900000000000000001' })).status).toBe(404);
  });

  it('HTTP：billing/summary 只返回调用者自己的积分', async () => {
    const rich = await newUser();
    const poor = await newUser();
    await seedLedgerEntry({ userId: rich.id, kind: 'topup', origin: 'payment', credits: 900, createTime: daysAgo(1) });
    await ensureCurrentPeriod(poor.id);

    const richSummary = await summaryOf(rich.cookie);
    expect(richSummary).toMatchObject({ available: 1400, limited: 500, lasting: 900, purchasedCredits60d: 900 });
    expect(await summaryOf(poor.cookie)).toMatchObject({ available: 500, limited: 500, lasting: 0 });
    expect((await billingRequest('billing/summary')).status).toBe(401);
  });
});
