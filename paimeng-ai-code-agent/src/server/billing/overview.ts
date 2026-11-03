import 'server-only';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditBalance, creditLedger, users } from '@/server/infra/schema';
import { idSchema } from '@/shared/contracts';
import {
  type AdminCreditAccount, type AdminCreditFilter, type AdminCreditOverview, type AdminCreditOverviewItem,
  type AdminCreditOverviewQuery, type AdminCreditSort, type AdminCreditUser, type AdminUserCreditDetail,
  type CreditLedgerEntryView, type QuotaPolicySource,
} from '@/shared/billing';
import { naiveTime, periodOf, periodRange } from './period';
import { accountSnapshot, ledgerEntryView } from './ledger';
import { ensureExpiry } from './expiry';
import { nextPeriodOf, resolveQuotaPolicy } from './quota-policy';

/**
 * Admin 全用户额度总览：金额从账本聚合，不逐用户写库。
 * 「待发」只看本期有没有规则行；「可用额」扣掉已到期但还没写过期行的余量（`pending` CTE）。
 */

type RawRow = Record<string, unknown>;
const number = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string => String(value ?? '');

function searchPattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function exactId(value: string): bigint | null {
  if (!/^[1-9]\d{0,19}$/u.test(value)) return null;
  return idSchema.safeParse(value).success ? BigInt(value) : null;
}

/**
 * 所有列表与统计共用的事实 CTE。同一份口径同时给分页、统计与单人详情，
 * 避免「列表说 120、点进去说 100」。
 */
function factsCte(period: string, at: Date): SQL {
  const { start, end } = periodRange(period);
  const atText = naiveTime(at);
  return sql`
    user_rows as (
      select id as user_id, user_account, user_name from app_user where is_delete = 0
    ),
    period_facts as (
      select user_id, period,
        sum(case when kind = 'quota' then credits else 0 end) as issued,
        sum(case when kind in ('consume', 'refund') then -credits else 0 end) as consumed,
        sum(case when kind = 'expire' then -credits else 0 end) as expired,
        bool_or(kind = 'expire' and origin = 'expiry') as swept
      from credit_ledger
      where period is not null
      group by user_id, period
    ),
    pending as (
      select user_id, sum(remainder) as remainder from (
        select user_id, issued - consumed - expired as remainder
        from period_facts
        where period < ${period} and not swept and issued - consumed - expired > 0
      ) p group by user_id
    ),
    limited as (
      select user_id, sum(remaining) as limited, min(expires_at) as limited_expires_at from (
        select user_id, period, sum(credits) as remaining,
          to_char(min(expires_at), 'YYYY-MM-DD HH24:MI:SS.MS') as expires_at
        from credit_ledger
        where period is not null and expires_at > ${atText}
        group by user_id, period
        having sum(credits) > 0
      ) b group by user_id
    ),
    totals as (
      select user_id, sum(credits) as raw from credit_ledger group by user_id
    ),
    rule_facts as (
      select user_id, credits from credit_ledger
      where kind = 'quota' and origin = 'rule' and period = ${period}
    ),
    issued_facts as (
      select user_id, sum(credits) as issued from credit_ledger
      where kind = 'quota' and period = ${period} group by user_id
    ),
    spent_facts as (
      select charge.user_id, sum(-ledger.credits) as spent
      from credit_ledger ledger
      join credit_charge charge on charge.generation_id = ledger.charge_id
      where ledger.kind = 'consume'
        and charge.create_time >= ${naiveTime(start)}
        and charge.create_time < ${naiveTime(end)}
      group by charge.user_id
    ),
    facts as (
      select u.user_id, u.user_account, u.user_name,
        coalesce(t.raw, 0) - coalesce(p.remainder, 0) as available,
        coalesce(l.limited, 0) as limited,
        l.limited_expires_at as limited_expires_at,
        coalesce(i.issued, 0) as issued,
        coalesce(s.spent, 0) as spent,
        (r.user_id is not null) as granted
      from user_rows u
      left join totals t on t.user_id = u.user_id
      left join pending p on p.user_id = u.user_id
      left join limited l on l.user_id = u.user_id
      left join rule_facts r on r.user_id = u.user_id
      left join issued_facts i on i.user_id = u.user_id
      left join spent_facts s on s.user_id = u.user_id
    )
  `;
}

function filterWhere(input: { q?: string; filter: AdminCreditFilter }): SQL {
  const parts: SQL[] = [sql`true`];
  if (input.q) {
    const pattern = searchPattern(input.q);
    const id = exactId(input.q);
    parts.push(sql`(user_account ilike ${pattern}
      or coalesce(user_name, '') ilike ${pattern}
      ${id === null ? sql`` : sql`or user_id = ${id}`})`);
  }
  if (input.filter === 'pending') parts.push(sql`not granted`);
  if (input.filter === 'debt') parts.push(sql`available < 0`);
  return sql.join(parts, sql` and `);
}

function sortOrder(sort: AdminCreditSort): SQL {
  switch (sort) {
    case 'available_desc': return sql`available desc, user_id desc`;
    case 'available_asc': return sql`available asc, user_id asc`;
    case 'limited_desc': return sql`limited desc, user_id desc`;
    case 'limited_asc': return sql`limited asc, user_id asc`;
    default: return sql`user_id desc`;
  }
}

function itemOf(row: RawRow, period: string): AdminCreditOverviewItem {
  const available = number(row.available);
  const limited = number(row.limited);
  return {
    userId: text(row.user_id),
    userAccount: text(row.user_account),
    userName: row.user_name === null || row.user_name === undefined ? null : String(row.user_name),
    period,
    available,
    limited,
    lasting: available - limited,
    limitedExpiresAt: row.limited_expires_at ? String(row.limited_expires_at) : null,
    debt: Math.max(0, -available),
    issued: number(row.issued),
    spent: number(row.spent),
    status: row.granted ? 'granted' : 'pending',
  };
}

export async function adminCreditOverview(input: AdminCreditOverviewQuery): Promise<AdminCreditOverview> {
  const at = new Date();
  const period = periodOf(at);
  const cte = factsCte(period, at);
  const where = filterWhere(input);
  const offset = (input.page - 1) * input.pageSize;
  const [rows, statsRows] = await Promise.all([
    db().execute(sql`with ${cte}
      select * from facts
      where ${where}
      order by ${sortOrder(input.sort)}
      limit ${input.pageSize} offset ${offset}`),
    db().execute(sql`with ${cte}
      select
        count(*)::integer as user_count,
        count(*) filter (where not granted)::integer as pending_count,
        count(*) filter (where available < 0)::integer as debtor_count,
        coalesce(sum(greatest(0, -available)), 0)::bigint as debt_total,
        coalesce(sum(limited), 0)::bigint as limited_total,
        coalesce(sum(available - limited), 0)::bigint as lasting_total,
        coalesce(sum(issued), 0)::bigint as issued_total,
        coalesce(sum(spent), 0)::bigint as spent_total
      from facts
      where ${where}`),
  ]);
  const stats = statsRows.rows[0] ?? {};
  return {
    period,
    asOf: now(),
    page: input.page,
    pageSize: input.pageSize,
    total: number(stats.user_count),
    items: rows.rows.map(row => itemOf(row as RawRow, period)),
    stats: {
      userCount: number(stats.user_count),
      pendingCount: number(stats.pending_count),
      debtorCount: number(stats.debtor_count),
      debtTotal: number(stats.debt_total),
      limitedTotal: number(stats.limited_total),
      lastingTotal: number(stats.lasting_total),
      issuedTotal: number(stats.issued_total),
      spentTotal: number(stats.spent_total),
    },
  };
}

/** 管理面用户搜索：只返回身份，不暴露余额；完整 ID 精确命中，账号/用户名大小写不敏感。 */
export async function searchAdminUsers(input: { q?: string; limit: number }): Promise<AdminCreditUser[]> {
  const q = input.q?.trim();
  const pattern = q ? searchPattern(q) : '%';
  const id = q ? exactId(q) : null;
  const rows = await db().execute(sql`
    select id, user_account, user_name
    from app_user
    where is_delete = 0
      and (user_account ilike ${pattern} or coalesce(user_name, '') ilike ${pattern}
        ${id === null ? sql`` : sql`or id = ${id}`})
    order by ${id === null ? sql`` : sql`(id = ${id}) desc,`} user_account asc
    limit ${input.limit}`);
  return rows.rows.map(row => ({
    userId: text(row.id),
    userAccount: text(row.user_account),
    userName: row.user_name === null || row.user_name === undefined ? null : String(row.user_name),
  }));
}

/**
 * 单人详情：身份、积分事实、规则、最近流水与快照核对。
 * 打开详情会先补写该用户已结束账期的过期行（懒触发），所以这里的数已经是最终口径。
 */
export async function adminUserCreditDetail(userId: string): Promise<AdminUserCreditDetail> {
  const at = new Date();
  const period = periodOf(at);
  await ensureExpiry(userId, at);

  const [identity] = await db().select({ id: users.id, account: users.userAccount, name: users.userName }).from(users)
    .where(eq(users.id, BigInt(userId))).limit(1);
  if (!identity) throw new BusinessError(404, 40400, '用户不存在');

  const [snapshot, currentRule, nextRule, ledgerPage, balanceRow] = await Promise.all([
    accountSnapshot(userId, at),
    resolveQuotaPolicy(db(), BigInt(userId), period),
    resolveQuotaPolicy(db(), BigInt(userId), nextPeriodOf(period)),
    adminCreditLedger({ userId, limit: 50 }),
    db().select().from(creditBalance).where(eq(creditBalance.userId, BigInt(userId))).limit(1),
  ]);

  const [ruleRow] = await db().select({ id: creditLedger.id }).from(creditLedger)
    .where(sql`${creditLedger.userId} = ${BigInt(userId)} and ${creditLedger.kind} = 'quota'
      and ${creditLedger.origin} = 'rule' and ${creditLedger.period} = ${period}`).limit(1);
  const [totals] = await db().execute(sql`select
    coalesce(sum(case when kind = 'quota' and period = ${period} then credits else 0 end), 0) as issued,
    coalesce(sum(case when kind = 'topup' then credits else 0 end), 0) as purchased,
    coalesce(sum(case when kind = 'topup' and create_time > ${naiveTime(new Date(at.getTime() - 60 * 86_400_000))} then credits else 0 end), 0) as purchased_60d,
    coalesce(sum(case when kind = 'grant' and origin = 'manual' then credits else 0 end), 0) as admin_granted,
    coalesce(sum(case when kind = 'consume' then -credits else 0 end), 0) as consumed
    from credit_ledger where user_id = ${BigInt(userId)}`).then(result => result.rows);
  const [spent] = await db().execute(sql`select coalesce(sum(-ledger.credits), 0) as spent
    from credit_ledger ledger
    join credit_charge charge on charge.generation_id = ledger.charge_id
    where ledger.user_id = ${BigInt(userId)} and ledger.kind = 'consume'
      and charge.create_time >= ${naiveTime(periodRange(period).start)}
      and charge.create_time < ${naiveTime(periodRange(period).end)}`).then(result => result.rows);

  const account: AdminCreditAccount = {
    period,
    available: snapshot.available,
    limited: snapshot.limited,
    limitedExpiresAt: snapshot.limitedExpiresAt,
    lasting: snapshot.lasting,
    debt: Math.max(0, -snapshot.available),
    issued: number(totals?.issued),
    spent: number(spent?.spent),
    status: ruleRow ? 'granted' : 'pending',
    policySource: currentRule.source as QuotaPolicySource,
    policyVersion: currentRule.version,
  };

  return {
    user: { userId: String(identity.id), userAccount: identity.account, userName: identity.name },
    account,
    purchasedCredits: number(totals?.purchased),
    purchasedCredits60d: number(totals?.purchased_60d),
    adminGrantedCredits: number(totals?.admin_granted),
    overdraft: snapshot.overdraft,
    snapshot: {
      available: balanceRow[0]?.available ?? 0,
      nextExpiryAt: balanceRow[0]?.nextExpiryAt ?? null,
      updateTime: balanceRow[0]?.updateTime ?? null,
    },
    snapshotAnomaly: (balanceRow[0]?.available ?? 0) !== snapshot.available,
    rule: { current: currentRule, next: nextRule },
    entries: ledgerPage.entries,
    asOf: now(),
  };
}

/** 单人流水分页：带累计可用额，供「加载更早」使用。 */
export async function adminCreditLedger(input: { userId: string; limit: number; beforeId?: number }): Promise<{
  entries: CreditLedgerEntryView[];
  hasMore: boolean;
}> {
  const before = input.beforeId ?? null;
  const result = await db().execute(sql`
    select * from (
      select id, user_id, kind, origin, credits, period,
        to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS.MS') as expires_at,
        charge_id, reversal_of, reason, operator_id, request_id, ref,
        to_char(create_time, 'YYYY-MM-DD HH24:MI:SS.MS') as create_time,
        sum(credits) over (order by create_time, id) as balance_after
      from credit_ledger where user_id = ${BigInt(input.userId)}
    ) t
    where (${before}::bigint is null or id < ${before})
    order by create_time desc, id desc
    limit ${input.limit + 1}`);
  const rows = result.rows.slice(0, input.limit);
  return {
    entries: rows.map(row => ledgerEntryView({
      id: BigInt(row.id as string),
      userId: BigInt(row.user_id as string),
      kind: row.kind as CreditLedgerEntryView['kind'],
      origin: row.origin as CreditLedgerEntryView['origin'],
      credits: Number(row.credits),
      period: (row.period as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
      chargeId: (row.charge_id as string | null) ?? null,
      reversalOf: row.reversal_of === null ? null : BigInt(row.reversal_of as string),
      reason: (row.reason as string | null) ?? null,
      operatorId: row.operator_id === null ? null : BigInt(row.operator_id as string),
      requestId: (row.request_id as string | null) ?? null,
      ref: (row.ref as string | null) ?? null,
      createTime: row.create_time as string,
    }, Number(row.balance_after))),
    hasMore: result.rows.length > input.limit,
  };
}
