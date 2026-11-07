import 'server-only';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '@/server/infra/db';
import {
  apps,
  creditBalance,
  creditCharges,
  creditLedger,
  generations,
} from '@/server/infra/schema';
import {
  type AccountSnapshot,
  type BillingChargeView,
  type ChargeStatus,
  type CreditBucket,
  type CreditEntryKind,
  type CreditEntryOrigin,
  type CreditLedgerEntryView,
  type RateCardView,
  type UsageSnapshotStep,
} from '@/shared/billing';
import { stopReasonFrom } from '@/server/generation/generation-accounting';
import { naiveTime } from './period';
import { balanceFactsOf, ensureExpiryTx, lockBalance, rebuildBalanceTx } from './expiry';

export type { ChargeStatus };
export type CreditLedgerRow = typeof creditLedger.$inferSelect;

const purchaseWindowMs = 60 * 86_400_000;
const maxOverdraftCredits = 500;

/**
 * 账本与账单：`credit_ledger` 是唯一真值，`credit_balance` 是锁点与快照。
 * `credit_charge.credits` / `status` 是同一事务里重算出来的投影，一次 Generation 一行。
 */

/** 近 60 天购买窗口的起点：滚动 60×24 小时之前，UTC 朴素时间戳（与 `now()` 同格式）。 */
export function purchaseWindowStart(asOf: Date = new Date()): string {
  return naiveTime(new Date(asOf.getTime() - purchaseWindowMs));
}

/** Overdraft = min(近 60 天购买入账总额 × 2%, 500)。它是熔断线，不是准入额度。 */
export function overdraftOf(purchasedCredits: number): number {
  if (!Number.isFinite(purchasedCredits) || purchasedCredits <= 0) return 0;
  return Math.min((purchasedCredits * 2) / 100, maxOverdraftCredits);
}

export type LedgerEntryInput = {
  userId: bigint;
  kind: CreditEntryKind;
  origin: CreditEntryOrigin;
  credits: number;
  period?: string | null;
  expiresAt?: string | null;
  chargeId?: string | null;
  reversalOf?: bigint | null;
  reason?: string | null;
  operatorId?: bigint | null;
  requestId?: string | null;
  ref?: string | null;
  createTime?: string;
};

/** 追加一行；唯一键冲突返回 null（调用方据此判断「这次是重放」）。 */
export async function insertLedgerTx(
  tx: Transaction,
  input: LedgerEntryInput,
): Promise<CreditLedgerRow | null> {
  const [row] = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      kind: input.kind,
      origin: input.origin,
      credits: input.credits,
      period: input.period ?? null,
      expiresAt: input.expiresAt ?? null,
      chargeId: input.chargeId ?? null,
      reversalOf: input.reversalOf ?? null,
      reason: input.reason ?? null,
      operatorId: input.operatorId ?? null,
      requestId: input.requestId ?? null,
      ref: input.ref ?? null,
      createTime: input.createTime ?? now(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** 一个用户的全部流水，按时间正序；用于读模型折叠（单人数据量有界）。 */
export async function entriesOfUser(userId: string, tx?: Transaction): Promise<CreditLedgerRow[]> {
  return (tx ?? db())
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, BigInt(userId)))
    .orderBy(asc(creditLedger.createTime), asc(creditLedger.id));
}

/** 余额快照：可用额、限时/长期拆分、近 60 天购买额与透支线。 */
export async function accountSnapshot(
  userId: string,
  at: Date = new Date(),
): Promise<AccountSnapshot> {
  const facts = await balanceFactsOf(userId, at);
  const [purchased] = await db()
    .select({ credits: sql<string>`coalesce(sum(${creditLedger.credits}), 0)` })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, BigInt(userId)),
        eq(creditLedger.kind, 'topup'),
        gt(creditLedger.createTime, purchaseWindowStart(at)),
      ),
    );
  const purchasedCredits60d = Number(purchased?.credits ?? 0);
  return { ...facts, purchasedCredits60d, overdraft: overdraftOf(purchasedCredits60d) };
}

/** 只读快照；与 `accountSnapshot` 同源，保留给准入与运行期熔断。 */
export async function availableCredits(
  userId: string,
  at: Date = new Date(),
): Promise<AccountSnapshot> {
  return accountSnapshot(userId, at);
}

/** 快照与账本的差异：diff = 快照 − 账本。修复走 `rebuildBalance`。 */
export async function auditBalance(
  userId: string,
  at: Date = new Date(),
): Promise<{
  expected: number;
  actual: number;
  diff: number;
}> {
  const facts = await balanceFactsOf(userId, at);
  const [row] = await db()
    .select({ available: creditBalance.available })
    .from(creditBalance)
    .where(eq(creditBalance.userId, BigInt(userId)))
    .limit(1);
  const actual = row?.available ?? 0;
  return { expected: facts.available, actual, diff: actual - facts.available };
}

/** 由账本重算并写回快照；先锁行、补过期，再重算。 */
export async function rebuildBalance(
  userId: string,
  at: Date = new Date(),
): Promise<AccountSnapshot> {
  return db().transaction(async (tx) => {
    await lockBalance(tx, BigInt(userId));
    await ensureExpiryTx(tx, userId, at);
    await rebuildBalanceTx(tx, userId, at);
    return accountSnapshot(userId, at);
  });
}

// ---- Charge 与分录 ----

export type CreditChargeRow = typeof creditCharges.$inferSelect;

/**
 * 幂等占用一次结算：插一条空投影的 charge 行，返回 null 表示这个 Generation 已经结算过。
 * 拿到行之后必须在同一事务里补齐投影与分录；事务回滚时占位行一起消失。
 */
export async function insertCharge(
  tx: Transaction,
  input: {
    generationId: string;
    appId: bigint;
    userId: bigint;
    createTime: string;
  },
): Promise<CreditChargeRow | null> {
  const [row] = await tx
    .insert(creditCharges)
    .values({
      generationId: input.generationId,
      appId: input.appId,
      userId: input.userId,
      credits: 0,
      costUsd: null,
      rateCardSnapshot: [],
      usageSnapshot: [],
      status: 'unpriced',
      estimatedSteps: 0,
      createTime: input.createTime,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** 写回 charge 的投影与两个不可变快照（定价结果）；分录由 `postConsume` 另外追加。 */
export async function projectCharge(
  tx: Transaction,
  input: {
    chargeId: string;
    credits: number;
    costUsd: string | null;
    status: ChargeStatus;
    estimatedSteps: number;
    usageSnapshot: UsageSnapshotStep[];
    rateCardSnapshot: RateCardView[];
  },
): Promise<void> {
  await tx
    .update(creditCharges)
    .set({
      credits: input.credits,
      costUsd: input.costUsd,
      status: input.status,
      estimatedSteps: input.estimatedSteps,
      usageSnapshot: input.usageSnapshot,
      rateCardSnapshot: input.rateCardSnapshot,
    })
    .where(eq(creditCharges.generationId, input.chargeId));
}

/**
 * 结算扣减：先补过期，再按到期顺序从限时积分里取，剩下的落长期积分。
 * 锁的是该用户唯一一行 `credit_balance`，同一 Owner 的并发结算在这里串行化。
 */
export async function postConsume(
  tx: Transaction,
  input: {
    chargeId: string;
    userId: bigint;
    credits: number;
    createTime: string;
    at?: Date;
  },
): Promise<void> {
  if (input.credits <= 0) return;
  const at = input.at ?? new Date();
  const atText = naiveTime(at);
  await lockBalance(tx, input.userId);
  await ensureExpiryTx(tx, String(input.userId), at);

  const buckets = await tx.execute(sql`
    select period, sum(credits)::bigint as remaining,
      to_char(min(expires_at), 'YYYY-MM-DD HH24:MI:SS.MS') as expires_at
    from credit_ledger
    where user_id = ${input.userId} and period is not null and expires_at > ${atText}
    group by period
    having sum(credits) > 0
    order by min(expires_at) asc, period asc`);

  let need = input.credits;
  for (const row of buckets.rows) {
    if (need <= 0) break;
    const take = Math.min(need, Number(row.remaining));
    if (take <= 0) continue;
    await insertLedgerTx(tx, {
      userId: input.userId,
      kind: 'consume',
      origin: 'charge',
      credits: -take,
      period: String(row.period),
      expiresAt: String(row.expires_at),
      chargeId: input.chargeId,
      createTime: input.createTime,
    });
    need -= take;
  }
  if (need > 0) {
    await insertLedgerTx(tx, {
      userId: input.userId,
      kind: 'consume',
      origin: 'charge',
      credits: -need,
      chargeId: input.chargeId,
      createTime: input.createTime,
    });
  }
  await rebuildBalanceTx(tx, String(input.userId), at);
}

/** 一个 charge 的全部分录（消费与退回），按写入顺序。 */
export async function entriesOfCharge(
  chargeId: string,
  tx?: Transaction,
): Promise<CreditLedgerRow[]> {
  return (tx ?? db())
    .select()
    .from(creditLedger)
    .where(
      and(eq(creditLedger.chargeId, chargeId), inArray(creditLedger.kind, ['consume', 'refund'])),
    )
    .orderBy(asc(creditLedger.id));
}

/** 有效金额 = 该账单消费与退回的净额（正数）；冲正后变小。 */
export async function effectiveCreditsOf(chargeId: string, tx?: Transaction): Promise<number> {
  const [row] = await (tx ?? db())
    .select({ credits: sql<string>`coalesce(sum(${creditLedger.credits}), 0)` })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.chargeId, chargeId), inArray(creditLedger.kind, ['consume', 'refund'])),
    );
  return -Number(row?.credits ?? 0) || 0;
}

/**
 * 由分录重算 charge 投影：credits 永远等于消费净额；每条消费都有退回时投影成 `reversed`。
 * 冲正只追加行，然后调这里一次，不直接改 status。
 */
export async function reprojectCharge(
  tx: Transaction,
  chargeId: string,
): Promise<{ credits: number; reversed: boolean }> {
  const entries = await entriesOfCharge(chargeId, tx);
  const consumes = entries.filter((entry) => entry.kind === 'consume');
  const refunds = entries.filter((entry) => entry.kind === 'refund');
  const credits = -entries.reduce((sum, entry) => sum + entry.credits, 0);
  const reversed =
    consumes.length > 0 &&
    consumes.every((entry) => refunds.some((refund) => refund.reversalOf === entry.id));
  await tx
    .update(creditCharges)
    .set(reversed ? { credits, status: 'reversed' } : { credits })
    .where(eq(creditCharges.generationId, chargeId));
  return { credits, reversed };
}

// ---- 冲正 ----

export type ReversalInput = {
  /** 为什么退：自动冲正写 `platformReversalReason`，人工冲正写管理员填的原因。 */
  reason: string;
  operatorId?: string | null;
  at?: Date;
};

export type ReversalResult = { reversed: boolean; entries: number };

/**
 * 幂等整笔冲正：为每条还没有退回的消费追加一条同额正数 `refund`，继承原 `period` / `expires_at`。
 * 原账期已经过期时，同事务再写一条 `origin='reversal'` 的 `expire` 把这次退回清掉：
 * 账本上看得到「退回 + 已过期」，余额不变，已失效的积分不会被复活。
 */
export async function reverseCharge(
  chargeId: string,
  input: ReversalInput,
): Promise<ReversalResult> {
  return db().transaction((tx) => reverseChargeTx(tx, chargeId, input));
}

export async function reverseChargeTx(
  tx: Transaction,
  chargeId: string,
  input: ReversalInput,
): Promise<ReversalResult> {
  const [charge] = await tx
    .select()
    .from(creditCharges)
    .where(eq(creditCharges.generationId, chargeId))
    .limit(1)
    .for('update');
  if (!charge) return { reversed: false, entries: 0 };

  const open = await tx
    .select()
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.chargeId, chargeId),
        eq(creditLedger.kind, 'consume'),
        sql`not exists (select 1 from credit_ledger r where r.reversal_of = ${creditLedger.id})`,
      ),
    )
    .orderBy(asc(creditLedger.id));
  if (!open.length) return { reversed: false, entries: 0 };

  const at = input.at ?? new Date();
  const atText = naiveTime(at);
  const createTime = now();
  const operatorId = input.operatorId ? BigInt(input.operatorId) : null;
  await lockBalance(tx, charge.userId);
  await ensureExpiryTx(tx, String(charge.userId), at);

  for (const entry of open) {
    const refund = await insertLedgerTx(tx, {
      userId: charge.userId,
      kind: 'refund',
      origin: 'reversal',
      credits: -entry.credits,
      period: entry.period,
      expiresAt: entry.expiresAt,
      chargeId,
      reversalOf: entry.id,
      reason: input.reason,
      operatorId,
      createTime,
    });
    if (!refund) continue;
    if (entry.expiresAt !== null && entry.expiresAt <= atText) {
      await insertLedgerTx(tx, {
        userId: charge.userId,
        kind: 'expire',
        origin: 'reversal',
        credits: entry.credits,
        period: entry.period,
        expiresAt: entry.expiresAt,
        reason: '冲正退回时该额度已过期',
        operatorId,
        createTime,
      });
    }
  }

  await rebuildBalanceTx(tx, String(charge.userId), at);
  const projection = await reprojectCharge(tx, chargeId);
  return { reversed: projection.reversed, entries: open.length };
}

// ---- 账单读模型 ----

/** 账本行 → 对外的流水视图；`balanceAfter` 由调用方补。 */
export function ledgerEntryView(
  row: CreditLedgerRow,
  balanceAfter?: number,
): CreditLedgerEntryView {
  return {
    id: String(row.id),
    userId: String(row.userId),
    kind: row.kind,
    origin: row.origin,
    credits: row.credits,
    period: row.period,
    expiresAt: row.expiresAt,
    chargeId: row.chargeId,
    reversalOf: row.reversalOf === null ? null : String(row.reversalOf),
    reason: row.reason,
    operatorId: row.operatorId === null ? null : String(row.operatorId),
    requestId: row.requestId,
    ref: row.ref,
    createTime: row.createTime,
    ...(balanceAfter === undefined ? {} : { balanceAfter }),
  };
}

/**
 * `GET billing/charges` 的读模型：最近的 Charge + 消费/退回分录 + 所属 Generation 的终态。
 * 范围是**一个人**：`appId` 给了就只看那个 App（HTTP 层已先校验所有权），缺省就是此人的全部 App。
 */
export async function chargesOf(input: {
  appId?: string;
  userId: string;
  limit: number;
  includeCost: boolean;
}): Promise<BillingChargeView[]> {
  const rows = await db()
    .select({
      generationId: creditCharges.generationId,
      appId: creditCharges.appId,
      appName: apps.appName,
      credits: creditCharges.credits,
      costUsd: creditCharges.costUsd,
      status: creditCharges.status,
      estimatedSteps: creditCharges.estimatedSteps,
      usageSnapshot: creditCharges.usageSnapshot,
      createTime: creditCharges.createTime,
      messageId: generations.messageId,
      generationStatus: generations.status,
      stopReason: generations.stopReason,
    })
    .from(creditCharges)
    .leftJoin(generations, eq(generations.id, creditCharges.generationId))
    .leftJoin(apps, eq(apps.id, creditCharges.appId))
    .where(
      and(
        eq(creditCharges.userId, BigInt(input.userId)),
        ...(input.appId ? [eq(creditCharges.appId, BigInt(input.appId))] : []),
      ),
    )
    .orderBy(desc(creditCharges.createTime), desc(creditCharges.generationId))
    .limit(input.limit);
  if (!rows.length) return [];
  const entries = await db()
    .select()
    .from(creditLedger)
    .where(
      inArray(
        creditLedger.chargeId,
        rows.map((row) => row.generationId),
      ),
    )
    .orderBy(asc(creditLedger.id));
  return rows.map((row) => {
    const own = entries.filter(
      (entry) =>
        entry.chargeId === row.generationId &&
        (entry.kind === 'consume' || entry.kind === 'refund'),
    );
    const view: BillingChargeView = {
      generationId: row.generationId,
      messageId: row.messageId ?? null,
      appId: String(row.appId),
      appName: row.appName ?? null,
      credits: row.credits,
      effectiveCredits: -own.reduce((sum, entry) => sum + entry.credits, 0),
      status: row.status,
      estimatedSteps: row.estimatedSteps,
      estimated: row.estimatedSteps > 0 || row.usageSnapshot.some((step) => step.estimated),
      unpriced: row.usageSnapshot.some((step) => !step.priced),
      createTime: row.createTime,
      generationStatus: row.generationStatus as BillingChargeView['generationStatus'],
      stopReason: stopReasonFrom(row.stopReason),
      entries: own
        .filter((entry) => entry.kind === 'consume')
        .map((entry) => ({ bucket: bucketOf(entry), credits: -entry.credits })),
      reversals: own
        .filter((entry) => entry.kind === 'refund')
        .map((entry) => ({
          bucket: bucketOf(entry),
          credits: -entry.credits,
          reason: entry.reason,
          createTime: entry.createTime,
        })),
    };
    if (input.includeCost) view.costUsd = row.costUsd ?? null;
    return view;
  });
}

function bucketOf(row: CreditLedgerRow): CreditBucket {
  return row.expiresAt === null ? 'lasting' : 'limited';
}
