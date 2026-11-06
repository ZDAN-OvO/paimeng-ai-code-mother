import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditQuotaPolicies, users } from '@/server/infra/schema';
import {
  monthlyQuotaCredits,
  maxMonthlyQuotaCredits,
  maxIssueCredits,
  type AdminCreditAccount,
  type EffectiveQuotaPolicy,
  type QuotaPolicyAdminView,
  type QuotaPolicyRange,
  type QuotaPolicySaveReceipt,
  type QuotaPolicyView,
  type QuotaPolicyScope,
} from '@/shared/billing';
import { periodOf } from './period';
import { accountSnapshot } from './ledger';
import { ensureExpiry } from './expiry';
import type { Transaction } from '@/server/infra/db';

/**
 * 月度配额策略：只追加版本，解析时取「生效账期 <= 目标账期」的最后一版。
 *
 * - 保存只允许未来账期；当月修改走 C3 的单用户调整，不能追溯改已发放月份。
 * - 用户策略可以显式 `inherit`（清除覆盖），这与「覆盖为 0」是两种事实。
 * - 没有保存过全局策略时返回 500 兜底，来源记为 `fallback`，不伪造策略行。
 */

type Run = ReturnType<typeof db> | Transaction;

export function nextPeriodOf(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

function policyViewOf(row: typeof creditQuotaPolicies.$inferSelect): QuotaPolicyView {
  return {
    id: row.id,
    scope: row.scope,
    userId: row.userId === null ? null : String(row.userId),
    effectivePeriod: row.effectivePeriod,
    mode: row.mode,
    credits: row.credits,
    revision: row.revision,
    note: row.note,
    createdBy: row.createdBy === null ? null : String(row.createdBy),
    createTime: row.createTime,
  };
}

async function latestPolicy(
  run: Run,
  scope: QuotaPolicyScope,
  userId: bigint | null,
  period: string,
) {
  const condition =
    scope === 'global'
      ? and(
          eq(creditQuotaPolicies.scope, 'global'),
          lte(creditQuotaPolicies.effectivePeriod, period),
        )
      : and(
          eq(creditQuotaPolicies.scope, 'user'),
          eq(creditQuotaPolicies.userId, userId!),
          lte(creditQuotaPolicies.effectivePeriod, period),
        );
  const [row] = await run
    .select()
    .from(creditQuotaPolicies)
    .where(condition)
    .orderBy(desc(creditQuotaPolicies.effectivePeriod), desc(creditQuotaPolicies.revision))
    .limit(1);
  return row ?? null;
}

async function resolveGlobalPolicy(run: Run, period: string): Promise<EffectiveQuotaPolicy> {
  const row = await latestPolicy(run, 'global', null, period);
  if (!row || row.mode !== 'override' || row.credits === null) {
    return {
      credits: monthlyQuotaCredits,
      source: 'fallback',
      version: null,
      policyId: null,
      effectivePeriod: null,
    };
  }
  return {
    credits: row.credits,
    source: 'global',
    version: row.revision,
    policyId: row.id,
    effectivePeriod: row.effectivePeriod,
  };
}

/** 用户覆盖优先于全局；`inherit` 表示显式清除覆盖，继续用全局。 */
export async function resolveQuotaPolicy(
  run: Run,
  userId: bigint,
  period: string,
): Promise<EffectiveQuotaPolicy> {
  const override = await latestPolicy(run, 'user', userId, period);
  if (override?.mode === 'override' && override.credits !== null) {
    return {
      credits: override.credits,
      source: 'user',
      version: override.revision,
      policyId: override.id,
      effectivePeriod: override.effectivePeriod,
    };
  }
  return resolveGlobalPolicy(run, period);
}

async function versionsOf(
  scope: QuotaPolicyScope,
  userId: bigint | null,
  fromPeriod: string,
): Promise<QuotaPolicyView[]> {
  const condition =
    scope === 'global'
      ? and(
          eq(creditQuotaPolicies.scope, 'global'),
          sql`${creditQuotaPolicies.effectivePeriod} >= ${fromPeriod}`,
        )
      : and(
          eq(creditQuotaPolicies.scope, 'user'),
          eq(creditQuotaPolicies.userId, userId!),
          sql`${creditQuotaPolicies.effectivePeriod} >= ${fromPeriod}`,
        );
  const rows = await db()
    .select()
    .from(creditQuotaPolicies)
    .where(condition)
    .orderBy(desc(creditQuotaPolicies.effectivePeriod), desc(creditQuotaPolicies.revision))
    .limit(50);
  return rows.map(policyViewOf);
}

function periodStart(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1) - 8 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 23).replace('T', ' ');
}

function periodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 1) - 8 * 60 * 60 * 1000);
  return end.toISOString().slice(0, 23).replace('T', ' ');
}

/** 管理面读取：当前/下一账期的全局规则，可附带一个用户的覆盖规则与未来版本。 */
export async function readQuotaPolicyAdmin(input: {
  userId?: string;
}): Promise<QuotaPolicyAdminView> {
  const period = periodOf(new Date());
  const nextPeriod = nextPeriodOf(period);
  const [globalCurrent, globalNext, globalVersions] = await Promise.all([
    resolveGlobalPolicy(db(), period),
    resolveGlobalPolicy(db(), nextPeriod),
    versionsOf('global', null, period),
  ]);
  const global: QuotaPolicyRange = {
    current: globalCurrent,
    next: globalNext,
    versions: globalVersions,
  };
  if (!input.userId) {
    return {
      period,
      nextPeriod,
      defaultCredits: monthlyQuotaCredits,
      limits: { maxMonthlyQuotaCredits, maxIssueCredits },
      global,
      user: null,
    };
  }
  const userId = BigInt(input.userId);
  const [user] = await db()
    .select({ id: users.id, account: users.userAccount, name: users.userName })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isDelete, 0)))
    .limit(1);
  if (!user) throw new BusinessError(404, 40400, '用户不存在');
  await ensureExpiry(String(userId), new Date());
  const [current, next, versions, snapshot] = await Promise.all([
    resolveQuotaPolicy(db(), userId, period),
    resolveQuotaPolicy(db(), userId, nextPeriod),
    versionsOf('user', userId, period),
    accountSnapshot(String(userId)),
  ]);
  const [ruleRow] = await db()
    .execute(
      sql`select 1 from credit_ledger
    where user_id = ${userId} and kind = 'quota' and origin = 'rule' and period = ${period} limit 1`,
    )
    .then((result) => result.rows);
  const [totals] = await db()
    .execute(
      sql`select
    coalesce((select sum(credits) from credit_ledger
      where user_id = ${userId} and kind = 'quota' and period = ${period}), 0) as issued,
    coalesce((select sum(-ledger.credits) from credit_ledger ledger
      join credit_charge charge on charge.generation_id = ledger.charge_id
      where ledger.user_id = ${userId} and ledger.kind = 'consume'
        and charge.create_time >= ${periodStart(period)} and charge.create_time < ${periodEnd(period)}), 0) as spent`,
    )
    .then((result) => result.rows);
  const account: AdminCreditAccount = {
    period,
    available: snapshot.available,
    limited: snapshot.limited,
    lasting: snapshot.lasting,
    limitedExpiresAt: snapshot.limitedExpiresAt,
    debt: Math.max(0, -snapshot.available),
    issued: Number(totals?.issued ?? 0),
    spent: Number(totals?.spent ?? 0),
    status: ruleRow ? 'granted' : 'pending',
    policySource: current.source,
    policyVersion: current.version,
  };
  return {
    period,
    nextPeriod,
    defaultCredits: monthlyQuotaCredits,
    limits: { maxMonthlyQuotaCredits, maxIssueCredits },
    global,
    user: {
      userId: String(user.id),
      userAccount: user.account,
      userName: user.name,
      current,
      next,
      versions,
      account,
    },
  };
}

/**
 * 保存一个未来账期的策略版本。并发保存用 `expectedRevision` 做乐观锁：
 * 客户端先读到的版本被其他人改过时返回 409，不静默覆盖。
 */
export async function saveQuotaPolicy(
  input: {
    scope: QuotaPolicyScope;
    userId?: string;
    effectivePeriod: string;
    mode: 'inherit' | 'override';
    credits?: number | null;
    expectedRevision?: number | null;
    note?: string | null;
  },
  operatorId: string,
): Promise<QuotaPolicySaveReceipt> {
  const currentPeriod = periodOf(new Date());
  if (input.effectivePeriod <= currentPeriod) {
    throw new BusinessError(
      400,
      40000,
      '策略只能从未来账期生效；当月要改某个人，请用「发放限时积分」追加一条条目',
    );
  }
  if (input.scope === 'global' && input.mode !== 'override') {
    throw new BusinessError(400, 40000, '全局策略必须是覆盖金额');
  }
  if (input.scope === 'user' && !input.userId) {
    throw new BusinessError(400, 40000, '用户策略必须指定 userId');
  }
  const userId = input.scope === 'user' ? BigInt(input.userId!) : null;
  if (input.scope === 'user') {
    const [user] = await db()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId!), eq(users.isDelete, 0)))
      .limit(1);
    if (!user) throw new BusinessError(404, 40400, '用户不存在');
  }
  const credits = input.mode === 'inherit' ? null : (input.credits ?? null);
  if (
    input.mode === 'override' &&
    (credits === null ||
      !Number.isInteger(credits) ||
      credits < 0 ||
      credits > maxMonthlyQuotaCredits)
  ) {
    throw new BusinessError(
      400,
      40000,
      `每月额度必须是 0 到 ${maxMonthlyQuotaCredits} 之间的整数积分`,
    );
  }

  return db().transaction(async (tx) => {
    const lockKey = `credit_quota_policy:${input.scope}:${userId ?? 'global'}:${input.effectivePeriod}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const condition =
      input.scope === 'global'
        ? and(
            eq(creditQuotaPolicies.scope, 'global'),
            eq(creditQuotaPolicies.effectivePeriod, input.effectivePeriod),
          )
        : and(
            eq(creditQuotaPolicies.scope, 'user'),
            eq(creditQuotaPolicies.userId, userId!),
            eq(creditQuotaPolicies.effectivePeriod, input.effectivePeriod),
          );
    const [latest] = await tx
      .select()
      .from(creditQuotaPolicies)
      .where(condition)
      .orderBy(desc(creditQuotaPolicies.revision))
      .limit(1);
    const currentRevision = latest?.revision ?? null;
    const expected = input.expectedRevision ?? null;
    if (currentRevision !== expected) {
      throw new BusinessError(
        409,
        40900,
        expected === null
          ? `这个账期已经有策略版本（v${currentRevision}），请刷新后再保存`
          : `策略已被其他人更新（当前 v${currentRevision}，你读到 v${expected}），请刷新后重试`,
      );
    }
    const [row] = await tx
      .insert(creditQuotaPolicies)
      .values({
        id: randomUUID(),
        scope: input.scope,
        userId,
        effectivePeriod: input.effectivePeriod,
        mode: input.mode,
        credits,
        revision: (currentRevision ?? 0) + 1,
        note: input.note ?? null,
        createdBy: BigInt(operatorId),
        createTime: now(),
      })
      .returning();
    const effective =
      input.scope === 'global'
        ? await resolveGlobalPolicy(tx, input.effectivePeriod)
        : await resolveQuotaPolicy(tx, userId!, input.effectivePeriod);
    return { policy: policyViewOf(row), effective };
  });
}
