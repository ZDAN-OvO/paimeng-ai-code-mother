import 'server-only';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import { creditBalance, creditLedger } from '@/server/infra/schema';
import { naiveTime, periodOf, periodRange } from './period';

/**
 * 过期与余额：账期边界把上期剩余写成一条 `expire` 行；`credit_balance` 只是锁点与快照。
 *
 * 写入路径（懒触发与 CLI）都调 `ensureExpiry`；读路径不写库，用同一段 SQL 把
 * 「已到期但还没写过期行」的余量从可用额里扣掉。两处共用 `pendingExpirySql`，口径不会漂移。
 */

export type BalanceFacts = {
  available: number;
  limited: number;
  limitedExpiresAt: string | null;
  lasting: number;
};

/** 已结束账期里、还没写过期行的余量。`period` 是「现在」所属的北京账期。 */
function pendingExpirySql(period: string, userId?: bigint): SQL {
  const scope = userId === undefined ? sql`` : sql`and l.user_id = ${userId}`;
  const remainder = sql`
    sum(case when l.kind = 'quota' then l.credits else 0 end)
    - sum(case when l.kind in ('consume', 'refund') then -l.credits else 0 end)
    - sum(case when l.kind = 'expire' then -l.credits else 0 end)`;
  return sql`(
    select l.user_id, l.period, ${remainder} as remainder
    from credit_ledger l
    where l.period is not null
      and l.period < ${period}
      and not exists (
        select 1 from credit_ledger e
        where e.user_id = l.user_id and e.period = l.period
          and e.kind = 'expire' and e.origin = 'expiry'
      )
      ${scope}
    group by l.user_id, l.period
    having ${remainder} > 0
  )`;
}

/** 从账本读余额事实：可用额扣掉未写出的过期余量；限时是未到期账期的剩余。 */
export async function balanceFactsOf(
  userId: string,
  at: Date = new Date(),
  tx?: Transaction,
): Promise<BalanceFacts> {
  const run = tx ?? db();
  const id = BigInt(userId);
  const period = periodOf(at);
  const atText = naiveTime(at);
  const [totals, pending, buckets] = await Promise.all([
    run
      .select({ available: sql<string>`coalesce(sum(${creditLedger.credits}), 0)` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, id)),
    run.execute(
      sql`select coalesce(sum(p.remainder), 0) as pending from ${pendingExpirySql(period, id)} p`,
    ),
    run.execute(sql`
      select period, sum(credits)::bigint as remaining,
        to_char(min(expires_at), 'YYYY-MM-DD HH24:MI:SS.MS') as expires_at
      from credit_ledger
      where user_id = ${id} and period is not null and expires_at > ${atText}
      group by period
      having sum(credits) > 0
      order by min(expires_at) asc`),
  ]);
  const available = Number(totals[0]?.available ?? 0) - Number(pending.rows[0]?.pending ?? 0);
  const limited = buckets.rows.reduce((sum, row) => sum + Number(row.remaining ?? 0), 0);
  const limitedExpiresAt = buckets.rows.length ? String(buckets.rows[0].expires_at) : null;
  return { available, limited, limitedExpiresAt, lasting: available - limited };
}

/**
 * 懒触发与 CLI 共用的过期写入：每个已结束账期一条负行，金额 = 发放 − 消费净额 − 已过期。
 * `create_time` 记账期结束时刻，流水按时间读才对；重复调用由部分唯一索引兜底。
 */
export async function ensureExpiryTx(
  tx: Transaction,
  userId: string,
  at: Date = new Date(),
): Promise<number> {
  const id = BigInt(userId);
  const result = await tx.execute(
    sql`select period, remainder from ${pendingExpirySql(periodOf(at), id)} p order by period`,
  );
  let written = 0;
  for (const row of result.rows) {
    const period = String(row.period);
    const end = naiveTime(periodRange(period).end);
    const [inserted] = await tx
      .insert(creditLedger)
      .values({
        userId: id,
        kind: 'expire',
        origin: 'expiry',
        credits: -Number(row.remainder),
        period,
        expiresAt: end,
        reason: '上期未用完的限时积分',
        createTime: end,
      })
      .onConflictDoNothing()
      .returning({ id: creditLedger.id });
    if (inserted) written += 1;
  }
  return written;
}

export async function ensureExpiry(userId: string, at: Date = new Date()): Promise<number> {
  return db().transaction(async (tx) => {
    const written = await ensureExpiryTx(tx, userId, at);
    // 写过期行会改变可用额：同一事务里把快照收回，避免 CLI/详情页留下漂移。
    if (written > 0) await rebuildBalanceTx(tx, userId, at);
    return written;
  });
}

/** 在事务里锁住快照行；没有行就先建一行 0，再锁。所有写路径都从这里开始串行化。 */
export async function lockBalance(
  tx: Transaction,
  userId: bigint,
): Promise<{ available: number; nextExpiryAt: string | null }> {
  await tx
    .insert(creditBalance)
    .values({ userId, available: 0, nextExpiryAt: null, updateTime: now() })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(creditBalance)
    .where(eq(creditBalance.userId, userId))
    .for('update');
  return { available: row?.available ?? 0, nextExpiryAt: row?.nextExpiryAt ?? null };
}

/** 锁内从账本重算并写回快照。调用前必须已经 `ensureExpiry`，否则快照会多算未写出的余量。 */
export async function rebuildBalanceTx(
  tx: Transaction,
  userId: string,
  at: Date = new Date(),
): Promise<BalanceFacts> {
  const id = BigInt(userId);
  const facts = await balanceFactsOf(userId, at, tx);
  await tx
    .update(creditBalance)
    .set({
      available: facts.available,
      nextExpiryAt: facts.limitedExpiresAt,
      updateTime: now(),
    })
    .where(eq(creditBalance.userId, id));
  return facts;
}

/** 只读统计：有多少人、多少积分等着写过期行（CLI 的 --dry-run）。 */
export async function pendingExpiryStats(
  at: Date = new Date(),
): Promise<{ users: number; credits: number }> {
  const result = await db().execute(sql`
    select count(*)::int as users, coalesce(sum(p.remainder), 0)::bigint as credits
    from ${pendingExpirySql(periodOf(at))} p`);
  const row = result.rows[0] ?? {};
  return { users: Number(row.users ?? 0), credits: Number(row.credits ?? 0) };
}

/**
 * 全库扫描：给每个还有未写出过期余量的用户写过期行。
 * 返回写出的条数与涉及人数，供 CLI 与操作日志使用。
 */
export async function sweepExpiry(
  at: Date = new Date(),
): Promise<{ users: number; entries: number }> {
  const period = periodOf(at);
  const rows = await db().execute(sql`select distinct user_id from ${pendingExpirySql(period)} p`);
  let entries = 0;
  for (const row of rows.rows) {
    entries += await ensureExpiry(String(row.user_id), at);
  }
  return { users: rows.rows.length, entries };
}
