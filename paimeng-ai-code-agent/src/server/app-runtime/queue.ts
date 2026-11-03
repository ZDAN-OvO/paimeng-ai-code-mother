import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '../infra/db';
import { appRuntimeQueue, appRuntimes, generationTransitions } from '../infra/schema';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import { idSchema } from '@/shared/contracts';

/**
 * 运行时容量排队的持久层（migrations/025_app_runtime_queue.sql）。
 *
 * 这里只读写队列与「槽位占用」事实，不启动/停止容器、不碰生成生命周期：
 * - 槽位占用 = `app_runtime` 里 starting/ready 的 runtime + 已 granted 但还没有 runtime 行的排队记录。
 *   两段相加而不是只数一张表，是为了让「刚被批准、容器还没建好」的那一格也算数。
 * - 每 App 最多一条排队记录（主键 app_id）；排队本身不拿 Write authority，所以不会阻塞其他 App 生成。
 * - 到期判定一律用数据库时钟；应用进程只负责心跳与可读反馈。
 */

/** 与其他容量事务共用的 advisory lock；只包住「数格子 + 批准」这一小段，不包容器操作。 */
export const runtimeSlotLockKey = 0x72756e74696d6573n;

/** 排队/槽位只认 App 标识，不需要 codeGenType。 */
export type QueueApp = { id: string };

const appIdOf = (app: QueueApp) => BigInt(idSchema.parse(app.id));

export type QueueTicket = {
  appId: string;
  generationId: string;
  state: 'waiting' | 'granted';
  holder: string;
  enqueuedAt: string;
  heartbeatAt: string;
  waitDeadline: string;
};

function ticketView(row: typeof appRuntimeQueue.$inferSelect): QueueTicket {
  return {
    appId: String(row.appId),
    generationId: row.generationId,
    state: row.state,
    holder: row.holder,
    enqueuedAt: row.enqueuedAt,
    heartbeatAt: row.heartbeatAt,
    waitDeadline: row.waitDeadline,
  };
}

export async function readQueueTicket(app: QueueApp): Promise<QueueTicket | null> {
  const [row] = await db().select().from(appRuntimeQueue).where(eq(appRuntimeQueue.appId, appIdOf(app))).limit(1);
  return row ? ticketView(row) : null;
}

/** 队列里的等待者，按入队顺序；位置与 UI 文案共用这一份顺序。 */
export async function waitingQueue(): Promise<{ appId: string; generationId: string; enqueuedAt: string }[]> {
  const rows = await db().select({
    appId: appRuntimeQueue.appId, generationId: appRuntimeQueue.generationId, enqueuedAt: appRuntimeQueue.enqueuedAt,
  }).from(appRuntimeQueue).where(eq(appRuntimeQueue.state, 'waiting'))
    .orderBy(asc(appRuntimeQueue.enqueuedAt), asc(appRuntimeQueue.appId));
  return rows.map(row => ({ appId: String(row.appId), generationId: row.generationId, enqueuedAt: row.enqueuedAt }));
}

export async function queueDepth(): Promise<number> {
  const [row] = await db().select({ count: sql<number>`count(*)::int` }).from(appRuntimeQueue)
    .where(eq(appRuntimeQueue.state, 'waiting'));
  return Number(row?.count ?? 0);
}

/** 还没过等待截止的等待者：只有它们才值得为腾槽位去驱逐别的 runtime。 */
export async function activeQueueDepth(): Promise<number> {
  const [row] = await db().select({ count: sql<number>`count(*)::int` }).from(appRuntimeQueue)
    .where(and(eq(appRuntimeQueue.state, 'waiting'), sql`${appRuntimeQueue.waitDeadline} > timezone('UTC', now())`));
  return Number(row?.count ?? 0);
}

/** 已占用槽位数：见文件头的两段相加规则。 */
export async function runtimeSlotUsage(run: Transaction | ReturnType<typeof db> = db()): Promise<{ used: number; reserved: number }> {
  const result = await run.execute(sql`select
    (select count(*)::int from app_runtime where status in ('starting', 'ready')) as used,
    (select count(*)::int from app_runtime_queue q
      where q.state = 'granted'
        and not exists (select 1 from app_runtime r where r.app_id = q.app_id and r.status in ('starting', 'ready'))) as reserved`);
  const row = result.rows[0] as { used?: number; reserved?: number } | undefined;
  return { used: Number(row?.used ?? 0), reserved: Number(row?.reserved ?? 0) };
}

function insertTicket(
  tx: Transaction,
  input: { generationId: string; holder: string; deadline: string | null },
  appId: bigint,
  state: 'waiting' | 'granted',
  waitSeconds: number,
) {
  return tx.execute(sql`insert into app_runtime_queue
    (app_id, generation_id, state, holder, enqueued_at, heartbeat_at, wait_deadline, update_time)
    values (${appId}, ${input.generationId}, ${state}, ${input.holder}, timezone('UTC', now()), timezone('UTC', now()),
      least(coalesce(${input.deadline}::timestamp, 'infinity'::timestamp), timezone('UTC', now()) + make_interval(secs => ${waitSeconds})),
      timezone('UTC', now()))
    returning wait_deadline`);
}

export type SlotReservation =
  | { state: 'granted'; ticket: boolean }
  | { state: 'waiting'; position: number; waitDeadline: string };

/**
 * 占一格槽位或进队。必须在 generation 行之前调用：排队不抢写权限，所以没有 authority 也能留下排队事实。
 * `deadline` 是本轮 Generation 的绝对截止时间（数据库时钟算出的朴素时间），排队等待不会延长它。
 */
export async function reserveRuntimeTicket(input: {
  app: QueueApp;
  generationId: string;
  holder: string;
  deadline: string | null;
}): Promise<SlotReservation> {
  const config = getConfig();
  const appId = appIdOf(input.app);
  return db().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${runtimeSlotLockKey})`);
    // 已经有 runtime 的 App 直接算有槽位：唤醒不会再占第二格。
    const [runtime] = await tx.select({ status: appRuntimes.status }).from(appRuntimes)
      .where(eq(appRuntimes.appId, appId)).limit(1).for('update');
    if (runtime && (runtime.status === 'starting' || runtime.status === 'ready')) return { state: 'granted', ticket: false };
    const [existing] = await tx.select({ generationId: appRuntimeQueue.generationId }).from(appRuntimeQueue)
      .where(eq(appRuntimeQueue.appId, appId)).limit(1).for('update');
    if (existing) {
      if (existing.generationId === input.generationId) return (await readReservation(tx, input.app)) ?? { state: 'granted', ticket: false };
      throw new BusinessError(409, 40900, '应用已有排队中的生成');
    }
    const usage = await runtimeSlotUsage(tx);
    const used = usage.used + usage.reserved;
    const waiting = await queueDepth();
    // 队列非空时新请求排到队尾：空出来的槽位要先给已经在等的人，不能被新请求插队。
    if (waiting === 0 && used < config.appRuntime.maxSlots) {
      await insertTicket(tx, input, appId, 'granted', config.appRuntime.queueWaitTimeoutMs / 1000);
      return { state: 'granted', ticket: true };
    }
    if (waiting >= config.appRuntime.queueLimit) {
      throw new BusinessError(429, 42901, `运行时槽位已满（${config.appRuntime.maxSlots} 个），排队已满（${config.appRuntime.queueLimit} 个），请稍后再试`);
    }
    const inserted = await insertTicket(tx, input, appId, 'waiting', config.appRuntime.queueWaitTimeoutMs / 1000);
    const waitDeadline = String((inserted.rows[0] as { wait_deadline?: string } | undefined)?.wait_deadline ?? '');
    return { state: 'waiting', position: waiting + 1, waitDeadline };
  });
}

async function readReservation(tx: Transaction, app: QueueApp): Promise<SlotReservation | null> {
  const [row] = await tx.select().from(appRuntimeQueue).where(eq(appRuntimeQueue.appId, appIdOf(app))).limit(1);
  if (!row) return null;
  if (row.state === 'granted') return { state: 'granted', ticket: true };
  const waiting = await tx.select({ appId: appRuntimeQueue.appId }).from(appRuntimeQueue)
    .where(eq(appRuntimeQueue.state, 'waiting'))
    .orderBy(asc(appRuntimeQueue.enqueuedAt), asc(appRuntimeQueue.appId));
  const position = waiting.findIndex(item => String(item.appId) === app.id) + 1;
  return { state: 'waiting', position: position > 0 ? position : waiting.length + 1, waitDeadline: row.waitDeadline };
}

/**
 * 有空位就按 FIFO 批准等待者；返回这次批准的记录。
 * 「数格子 + 批准」在同一个 advisory lock 事务里，多个等待者并发 tick 也不会超发。
 */
export async function grantWaitingTickets(): Promise<{ appId: string; generationId: string }[]> {
  const config = getConfig();
  return db().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${runtimeSlotLockKey})`);
    const usage = await runtimeSlotUsage(tx);
    const free = config.appRuntime.maxSlots - (usage.used + usage.reserved);
    if (free <= 0) return [];
    const candidates = await tx.execute(sql`select app_id, generation_id from app_runtime_queue
      where state = 'waiting' and wait_deadline > timezone('UTC', now())
      order by enqueued_at, app_id
      limit ${free}`);
    const rows = candidates.rows as { app_id: string; generation_id: string }[];
    if (!rows.length) return [];
    await tx.execute(sql`update app_runtime_queue set state = 'granted', update_time = timezone('UTC', now())
      where app_id in (${sql.join(rows.map(row => sql`${BigInt(row.app_id)}`), sql`, `)}) and state = 'waiting'`);
    return rows.map(row => ({ appId: String(row.app_id), generationId: row.generation_id }));
  });
}

/** 心跳只证明「等待中的请求还活着」；granted 之后由运行时台账接管，不再靠心跳判定。 */
export async function heartbeatQueueTicket(app: QueueApp, generationId: string): Promise<void> {
  await db().update(appRuntimeQueue).set({ heartbeatAt: now(), updateTime: now() })
    .where(and(eq(appRuntimeQueue.appId, appIdOf(app)), eq(appRuntimeQueue.generationId, generationId)));
}

/** 释放这一 App 的排队记录；只删属于这一轮 generation 的行，避免误删后来者的排队。 */
export async function deleteQueueTicket(app: QueueApp, generationId?: string): Promise<boolean> {
  const result = await db().delete(appRuntimeQueue).where(and(
    eq(appRuntimeQueue.appId, appIdOf(app)),
    ...(generationId ? [eq(appRuntimeQueue.generationId, generationId)] : []),
  ));
  return (result.rowCount ?? 0) > 0;
}

/** 等待中的记录是否已经超过等待截止；只用数据库时钟判断。 */
export async function queueWaitExpired(app: QueueApp): Promise<boolean> {
  const result = await db().execute(sql`select (wait_deadline <= timezone('UTC', now())) as expired
    from app_runtime_queue where app_id = ${appIdOf(app)} and state = 'waiting'`);
  return Boolean((result.rows[0] as { expired?: boolean } | undefined)?.expired);
}

/**
 * 把一条仍在 queued 的 Generation 落成终态并清掉排队记录。
 * 排队没有执行行/写权限，所以不走 settleGeneration 的 authority 围栏；这里只允许 queued → 终态。
 * 返回 false 表示它已经不是 queued（已取消/已启动），调用方按读取到的真实状态处理。
 */
export async function failQueuedGeneration(input: {
  app: QueueApp;
  generationId: string;
  status: 'failed' | 'cancelled';
  error: string;
  stopReason: string;
}): Promise<boolean> {
  const settled = await db().transaction(async tx => {
    const result = await tx.execute(sql`update generation
      set status = ${input.status}, phase = 'finished', error = ${input.error}, stop_reason = ${input.stopReason}, update_time = ${now()}
      where id = ${input.generationId} and status = 'queued'`);
    if ((result.rowCount ?? 0) === 0) return false;
    await tx.insert(generationTransitions).values({
      appId: appIdOf(input.app), generationId: input.generationId,
      fromState: 'queued', toState: input.status, reason: input.error, createTime: now(),
    });
    await tx.delete(appRuntimeQueue).where(and(
      eq(appRuntimeQueue.appId, appIdOf(input.app)), eq(appRuntimeQueue.generationId, input.generationId),
    ));
    return true;
  });
  return settled;
}

/**
 * 进程崩溃/重启留下的等待者：心跳超时就把 Generation 收敛成 failed（interrupted），
 * 而不是重新启动它——同一请求不会因为一次 tick 被启动两次。
 * 已经 granted、但还没把 Generation 推进到 generating 也属于这一类：它占着槽位却没有执行者，
 * 必须回收；一旦进入 generating，后续由执行/对账路径接管，这里不再动。
 */
export async function abandonStaleWaitingGenerations(): Promise<string[]> {
  const leaseMs = getConfig().appRuntime.queueLeaseMs;
  const stale = await db().execute(sql`select q.app_id, q.generation_id
    from app_runtime_queue q join generation g on g.id = q.generation_id
    where q.heartbeat_at < timezone('UTC', now()) - make_interval(secs => ${leaseMs / 1000})
      and (q.state = 'waiting' or (q.state = 'granted' and g.status = 'queued'))`);
  const failed: string[] = [];
  for (const row of stale.rows as { app_id: string; generation_id: string }[]) {
    const app = { id: String(row.app_id) };
    const ok = await failQueuedGeneration({
      app, generationId: row.generation_id, status: 'failed',
      error: '生成进程中断，请重新提交', stopReason: 'interrupted',
    }).catch(() => false);
    if (ok) failed.push(row.generation_id);
  }
  return failed;
}
