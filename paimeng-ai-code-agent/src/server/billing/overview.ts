import 'server-only';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditAccounts, creditGrants, creditQuotaIssues } from '@/server/infra/schema';
import { idSchema } from '@/shared/contracts';
import {
  type AdminCreditFilter, type AdminCreditOverview, type AdminCreditOverviewItem, type AdminCreditOverviewQuery,
  type AdminCreditSort, type AdminCreditUser, type AdminQuotaDetail, type AdminQuotaStatus, type AdminUserCreditDetail,
  type CreditGrantView, type QuotaPolicySource,
} from '@/shared/billing';
import { naiveTime, periodOf, periodRange } from './period';
import { overdraftOf, purchaseWindowStart } from './ledger';
import { nextPeriodOf, resolveQuotaPolicy } from './quota-policy';

/**
 * Admin 全用户额度总览的只读读模型（C1）。
 *
 * 金额来自事实而不是 `credit_account` 快照：当期基础发放（现有 `monthly_quota` grant）、当期配额扣减、
 * 余额池 grant 与 entry。快照只用于核对异常，读路径不写库、不逐用户 `ensureCurrentPeriod`。
 * 无当期发放的用户显示「待发」，不把上个月的旧配额快照当成当前可用。
 */

const grantedStatus = 'granted' as const;
const pendingStatus = 'pending' as const;

type RawRow = Record<string, unknown>;

const number = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string => String(value ?? '');

/** 搜索模式：账号/用户名 OR 匹配，完整 ID 走精确命中；LIKE 元字符按反斜杠转义。 */
function searchPattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

/** 完整 ID 只在形如数字时尝试精确匹配：`idSchema` 的 refine 会对非数字直接抛 BigInt 错误。 */
function exactId(value: string): bigint | null {
  if (!/^[1-9]\d{0,19}$/u.test(value)) return null;
  return idSchema.safeParse(value).success ? BigInt(value) : null;
}

/** 同一个 facts CTE 同时给分页查询与统计用，保证两者看到同一份事实口径。 */
function factsCte(period: string): SQL {
  const { start, end } = periodRange(period);
  return sql`
    grant_facts as (
      select user_id,
        coalesce(sum(case when source = 'monthly_quota' and period = ${period} then credits else 0 end), 0) as monthly_granted,
        coalesce(sum(case when pool = 'balance' then credits else 0 end), 0) as balance_granted,
        coalesce(sum(case when source = 'purchase' then credits else 0 end), 0) as purchased_credits,
        coalesce(sum(case when source = 'purchase' and create_time > ${purchaseWindowStart()} then credits else 0 end), 0) as purchased_credits_60d,
        coalesce(sum(case when source = 'admin_grant' then credits else 0 end), 0) as admin_granted_credits
      from credit_grant
      group by user_id
    ),
    quota_used as (
      select charge.user_id, coalesce(sum(entry.credits), 0) as used
      from credit_entry entry
      join credit_charge charge on charge.generation_id = entry.charge_id
      where entry.pool = 'quota'
        and charge.create_time >= ${naiveTime(start)}
        and charge.create_time < ${naiveTime(end)}
      group by charge.user_id
    ),
    balance_used as (
      select charge.user_id, coalesce(sum(entry.credits), 0) as used
      from credit_entry entry
      join credit_charge charge on charge.generation_id = entry.charge_id
      where entry.pool = 'balance'
      group by charge.user_id
    ),
    issue_facts as (
      select user_id, base_credits, status, policy_source, policy_version
      from credit_quota_issue
      where period = ${period}
    ),
    account_snapshots as (
      select user_id,
        max(case when pool = 'quota' then balance end) as quota_snapshot,
        max(case when pool = 'balance' then balance end) as balance_snapshot,
        max(update_time) as snapshot_update_time
      from credit_account
      group by user_id
    ),
    facts as (
      select app_user.id as user_id,
        app_user.user_account,
        app_user.user_name,
        case when issue_facts.status = 'granted' then issue_facts.base_credits
          else coalesce(grant_facts.monthly_granted, 0) end::bigint as base_credits,
        0::bigint as adjustment_credits,
        coalesce(quota_used.used, 0)::bigint as used_credits,
        greatest(0,
          (case when issue_facts.status = 'granted' then issue_facts.base_credits
            else coalesce(grant_facts.monthly_granted, 0) end) - coalesce(quota_used.used, 0)
        )::bigint as remaining_credits,
        (coalesce(grant_facts.balance_granted, 0) - coalesce(balance_used.used, 0))::bigint as balance,
        coalesce(account_snapshots.quota_snapshot, 0)::bigint as quota_snapshot,
        coalesce(account_snapshots.balance_snapshot, 0)::bigint as balance_snapshot,
        account_snapshots.snapshot_update_time,
        coalesce(issue_facts.status,
          case when coalesce(grant_facts.monthly_granted, 0) > 0 then 'granted' else 'pending' end) as issue_status,
        coalesce(issue_facts.policy_source,
          case when coalesce(grant_facts.monthly_granted, 0) > 0 then 'legacy' else 'fallback' end) as policy_source,
        issue_facts.policy_version,
        (coalesce(grant_facts.balance_granted, 0) - coalesce(balance_used.used, 0)
          + greatest(0,
            (case when issue_facts.status = 'granted' then issue_facts.base_credits
              else coalesce(grant_facts.monthly_granted, 0) end) - coalesce(quota_used.used, 0)
          ))::bigint as total,
        greatest(0, -(coalesce(grant_facts.balance_granted, 0) - coalesce(balance_used.used, 0)))::bigint as debt,
        coalesce(grant_facts.purchased_credits, 0)::bigint as purchased_credits,
        coalesce(grant_facts.purchased_credits_60d, 0)::bigint as purchased_credits_60d,
        coalesce(grant_facts.admin_granted_credits, 0)::bigint as admin_granted_credits
      from app_user
      left join grant_facts on grant_facts.user_id = app_user.id
      left join quota_used on quota_used.user_id = app_user.id
      left join balance_used on balance_used.user_id = app_user.id
      left join issue_facts on issue_facts.user_id = app_user.id
      left join account_snapshots on account_snapshots.user_id = app_user.id
      where app_user.is_delete = 0
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
  switch (input.filter) {
    case 'pending': parts.push(sql`issue_status <> ${grantedStatus}`); break;
    case 'debt': parts.push(sql`balance < 0`); break;
    case 'zero': parts.push(sql`remaining_credits + balance <= 0`); break;
    case 'all': break;
  }
  return sql.join(parts, sql` and `);
}

function sortOrder(sort: AdminCreditSort): SQL {
  switch (sort) {
    case 'total_desc': return sql`total desc, user_id desc`;
    case 'total_asc': return sql`total asc, user_id asc`;
    case 'balance_desc': return sql`balance desc, user_id desc`;
    case 'balance_asc': return sql`balance asc, user_id asc`;
    case 'id_desc': return sql`user_id desc`;
  }
}

function itemOf(row: RawRow, period: string): AdminCreditOverviewItem {
  const issueStatus = (row.issue_status === grantedStatus ? grantedStatus : row.issue_status === 'failed' ? 'failed' : pendingStatus) as AdminQuotaStatus;
  const remainingCredits = number(row.remaining_credits);
  const balance = number(row.balance);
  const snapshotQuota = number(row.quota_snapshot);
  const snapshotBalance = number(row.balance_snapshot);
  return {
    userId: text(row.user_id),
    userAccount: text(row.user_account),
    userName: row.user_name === null || row.user_name === undefined ? null : String(row.user_name),
    period,
    quotaBase: number(row.base_credits),
    quotaAdjustments: number(row.adjustment_credits),
    quotaUsed: number(row.used_credits),
    quotaRemaining: remainingCredits,
    balance,
    total: number(row.total),
    debt: number(row.debt),
    issueStatus,
    policySource: String(row.policy_source) as QuotaPolicySource,
    policyVersion: row.policy_version === null || row.policy_version === undefined ? null : Number(row.policy_version),
    expiresAt: naiveTime(periodRange(period).end),
    // 未发用户的旧快照是跨月遗留，不是异常；已发用户才和事实对账。
    snapshotAnomaly: (issueStatus === grantedStatus && snapshotQuota !== remainingCredits) || snapshotBalance !== balance,
  };
}

export async function adminCreditOverview(input: AdminCreditOverviewQuery): Promise<AdminCreditOverview> {
  const period = periodOf(new Date());
  const cte = factsCte(period);
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
        count(*) filter (where issue_status <> ${grantedStatus})::integer as pending_count,
        coalesce(sum(remaining_credits), 0)::bigint as quota_remaining_total,
        coalesce(sum(balance), 0)::bigint as balance_net_total,
        count(*) filter (where balance < 0)::integer as debtor_count,
        coalesce(sum(greatest(0, -balance)), 0)::bigint as debt_total
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
      quotaRemainingTotal: number(stats.quota_remaining_total),
      balanceNetTotal: number(stats.balance_net_total),
      debtorCount: number(stats.debtor_count),
      debtTotal: number(stats.debt_total),
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
 * 单用户详情：总览同一份事实 + 最近流水 + 快照核对。
 * 这里同样只读；`snapshotAnomaly` 只报告差异，不修复、不写库。
 */
export async function adminUserCreditDetail(userId: string): Promise<AdminUserCreditDetail> {
  const period = periodOf(new Date());
  const cte = factsCte(period);
  const result = await db().execute(sql`with ${cte}
    select * from facts where user_id = ${BigInt(userId)} limit 1`);
  const row = result.rows[0] as RawRow | undefined;
  if (!row) throw new BusinessError(404, 40400, '用户不存在');

  const [grants, accounts, issues, currentRule, nextRule] = await Promise.all([
    db().select().from(creditGrants).where(eq(creditGrants.userId, BigInt(userId)))
      .orderBy(desc(creditGrants.createTime)).limit(50),
    db().select().from(creditAccounts).where(eq(creditAccounts.userId, BigInt(userId))),
    db().select().from(creditQuotaIssues).where(eq(creditQuotaIssues.userId, BigInt(userId)))
      .orderBy(desc(creditQuotaIssues.period)).limit(24),
    resolveQuotaPolicy(db(), BigInt(userId), period),
    resolveQuotaPolicy(db(), BigInt(userId), nextPeriodOf(period)),
  ]);
  const item = itemOf(row, period);
  const snapshotQuota = accounts.find(account => account.pool === 'quota')?.balance ?? 0;
  const snapshotBalance = accounts.find(account => account.pool === 'balance')?.balance ?? 0;
  const snapshotUpdateTime = accounts.reduce<string | null>(
    (latest, account) => latest === null || account.updateTime > latest ? account.updateTime : latest, null,
  );
  const purchasedCredits60d = number(row.purchased_credits_60d);
  const quota: AdminQuotaDetail = {
    period,
    baseCredits: item.quotaBase,
    adjustmentCredits: item.quotaAdjustments,
    usedCredits: item.quotaUsed,
    remainingCredits: item.quotaRemaining,
    issueStatus: item.issueStatus,
    policySource: item.policySource,
    policyVersion: item.policyVersion,
    expiresAt: item.expiresAt,
  };
  return {
    user: { userId: item.userId, userAccount: item.userAccount, userName: item.userName },
    period,
    quota,
    balance: item.balance,
    purchasedCredits: number(row.purchased_credits),
    purchasedCredits60d,
    adminGrantedCredits: number(row.admin_granted_credits),
    total: item.total,
    debt: item.debt,
    overdraft: overdraftOf(purchasedCredits60d),
    snapshot: { quota: snapshotQuota, balance: snapshotBalance, updateTime: snapshotUpdateTime },
    snapshotAnomaly: item.snapshotAnomaly,
    grants: grants.map(grantViewOf),
    rule: { current: currentRule, next: nextRule },
    issues: issues.map(issue => ({
      id: issue.id,
      userId: String(issue.userId),
      period: issue.period,
      baseCredits: issue.baseCredits,
      status: issue.status,
      policySource: issue.policySource,
      policyVersion: issue.policyVersion,
      policyId: issue.policyId,
      grantId: issue.grantId,
      reason: issue.reason,
      createTime: issue.createTime,
      updateTime: issue.updateTime,
    })),
    asOf: now(),
  };
}

function grantViewOf(row: typeof creditGrants.$inferSelect): CreditGrantView {
  return {
    id: row.id,
    userId: String(row.userId),
    pool: row.pool,
    credits: row.credits,
    source: row.source,
    note: row.note,
    requestId: row.requestId,
    grantedBy: row.grantedBy === null ? null : String(row.grantedBy),
    period: row.period,
    createTime: row.createTime,
  };
}

