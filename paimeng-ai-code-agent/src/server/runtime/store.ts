import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, now } from '../infra/db';
import { appAuthority, appRuntimes, apps, type AppRuntimeStatus } from '../infra/schema';
import { idSchema } from '@/shared/contracts';
import type { RuntimeApp } from './plan';
import { runtimeTimeMs } from './capacity';

/**
 * App runtime 的持久台账（migrations/025_app_runtime.sql）。
 *
 * 一行代表「某一轮运行里，平台认为某 App 的 runtime 是哪台容器」。主键是 (app_id, run_id)：
 * 两个 checkout 可以同时持有同一 App 的不同 run，互不覆盖。容器本身的事实由 Docker 持有；
 * 这张表只记录容器标识、dev server 端口、挂载的源码根、镜像身份与最后活动时间。
 */

export type AppRuntimeRecord = {
  appId: string;
  runId: string;
  containerId: string;
  containerName: string;
  port: number;
  imageIdentity: string;
  workspaceRoot: string;
  status: AppRuntimeStatus;
  lockDigest: string | null;
  lastError: string | null;
  lastActivityAt: string;
  createTime: string;
  updateTime: string;
};

const appIdOf = (app: RuntimeApp) => BigInt(idSchema.parse(app.id));

function view(row: typeof appRuntimes.$inferSelect): AppRuntimeRecord {
  return {
    appId: String(row.appId),
    runId: row.runId,
    containerId: row.containerId,
    containerName: row.containerName,
    port: row.port,
    imageIdentity: row.imageIdentity,
    workspaceRoot: row.workspaceRoot,
    status: row.status,
    lockDigest: row.lockDigest,
    lastError: row.lastError,
    lastActivityAt: row.lastActivityAt,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

export async function readAppRuntime(app: RuntimeApp, runId: string): Promise<AppRuntimeRecord | null> {
  const [row] = await db()
    .select()
    .from(appRuntimes)
    .where(and(eq(appRuntimes.appId, appIdOf(app)), eq(appRuntimes.runId, runId)))
    .limit(1);
  return row ? view(row) : null;
}

export async function saveAppRuntime(
  app: RuntimeApp,
  runId: string,
  input: {
    containerId: string;
    containerName: string;
    port: number;
    imageIdentity: string;
    workspaceRoot: string;
    status: AppRuntimeStatus;
    lockDigest: string | null;
    lastError: string | null;
    lastActivityAt?: string;
  },
): Promise<AppRuntimeRecord> {
  const at = input.lastActivityAt ?? now();
  const [row] = await db()
    .insert(appRuntimes)
    .values({
      appId: appIdOf(app),
      runId,
      containerId: input.containerId,
      containerName: input.containerName,
      port: input.port,
      imageIdentity: input.imageIdentity,
      workspaceRoot: input.workspaceRoot,
      status: input.status,
      lockDigest: input.lockDigest,
      lastError: input.lastError,
      lastActivityAt: at,
      createTime: at,
      updateTime: at,
    })
    .onConflictDoUpdate({
      target: [appRuntimes.appId, appRuntimes.runId],
      set: {
        containerId: input.containerId,
        containerName: input.containerName,
        port: input.port,
        imageIdentity: input.imageIdentity,
        workspaceRoot: input.workspaceRoot,
        status: input.status,
        lockDigest: input.lockDigest,
        lastError: input.lastError,
        lastActivityAt: at,
        updateTime: at,
      },
    })
    .returning();
  return view(row);
}

export async function updateAppRuntime(
  app: RuntimeApp,
  runId: string,
  patch: {
    status?: AppRuntimeStatus;
    port?: number;
    containerId?: string;
    lockDigest?: string | null;
    lastError?: string | null;
    lastActivityAt?: string;
  },
): Promise<void> {
  const at = patch.lastActivityAt ?? now();
  await db()
    .update(appRuntimes)
    .set({ ...patch, updateTime: at })
    .where(and(eq(appRuntimes.appId, appIdOf(app)), eq(appRuntimes.runId, runId)));
}

/** 活动时间只前移：同一毫秒内的重复写入不值得多一次表更新。 */
export async function touchAppRuntime(app: RuntimeApp, runId: string, at = now()): Promise<void> {
  await db()
    .update(appRuntimes)
    .set({ lastActivityAt: at, updateTime: at })
    .where(and(eq(appRuntimes.appId, appIdOf(app)), eq(appRuntimes.runId, runId)));
}

export async function deleteAppRuntime(app: RuntimeApp, runId: string): Promise<void> {
  await db()
    .delete(appRuntimes)
    .where(and(eq(appRuntimes.appId, appIdOf(app)), eq(appRuntimes.runId, runId)));
}

/** 读运行时台账（容量回收/驱逐与管理员视图共用）；不传状态就读全部。 */
export async function listAppRuntimes(
  statuses?: readonly AppRuntimeStatus[],
  runId?: string,
): Promise<AppRuntimeRecord[]> {
  const conditions = [
    ...(statuses?.length ? [inArray(appRuntimes.status, statuses)] : []),
    ...(runId ? [eq(appRuntimes.runId, runId)] : []),
  ];
  const rows = conditions.length
    ? await db()
        .select()
        .from(appRuntimes)
        .where(and(...conditions))
    : await db().select().from(appRuntimes);
  return rows.map(view);
}

/** 本轮台账行：别的 checkout 的行不参与对账、容量与恢复。 */
export function listRunRuntimes(
  runId: string,
  statuses?: readonly AppRuntimeStatus[],
): Promise<AppRuntimeRecord[]> {
  return listAppRuntimes(statuses, runId);
}

/** 回收失败时把行还原，避免容器还在跑、槽位却已经释放。 */
export async function restoreAppRuntime(record: AppRuntimeRecord): Promise<void> {
  await saveAppRuntime({ id: record.appId, codeGenType: 'react_project' }, record.runId, {
    containerId: record.containerId,
    containerName: record.containerName,
    port: record.port,
    imageIdentity: record.imageIdentity,
    workspaceRoot: record.workspaceRoot,
    status: record.status,
    lockDigest: record.lockDigest,
    lastError: record.lastError,
    lastActivityAt: record.lastActivityAt,
  });
}

export type SlotClaim = {
  claim: 'reserved' | 'busy' | 'evict' | 'full';
  /** `evict` 时调用方要先停掉这些容器，再把行标成 stopped，然后重新 claim。 */
  evicted: { appId: string; containerId: string }[];
};

const RUNTIME_SLOT_LOCK = sql`select pg_advisory_xact_lock(hashtext('paimeng-app-runtime'))`;

/**
 * 跨进程的槽位准入：一个 Postgres 事务里持有 advisory lock，数本轮活跃 runtime，挑 LRU 牺牲者。
 *
 * 事务只做决策与预留，不标 stopped、不碰 Docker：调用方先停容器、再释放行，然后重新 claim。
 * 这样「容器还在但槽位已让出」的窗口不存在，驱逐失败时行也仍是原状态。
 * 候选 App 的 `app` 与 `app_authority` 行按 id 升序 `FOR UPDATE`，与 `acquireAuthority` 同一把行锁，
 * 拿到写权限的 App 不会被并发驱逐。
 */
export async function claimRuntimeSlot(input: {
  app: RuntimeApp;
  runId: string;
  maxSlots: number;
  staleMs: number;
  containerName: string;
  port: number;
  imageIdentity: string;
  workspaceRoot: string;
}): Promise<SlotClaim> {
  const appId = appIdOf(input.app);
  return db().transaction(async (tx) => {
    await tx.execute(RUNTIME_SLOT_LOCK);
    const at = now();
    const rows = await tx
      .select()
      .from(appRuntimes)
      .where(
        and(
          eq(appRuntimes.runId, input.runId),
          inArray(appRuntimes.status, ['starting', 'ready']),
        ),
      );
    const own = rows.find((row) => row.appId === appId);
    if (own && own.status === 'starting' && Date.now() - runtimeTimeMs(own.updateTime) < input.staleMs) {
      return { claim: 'busy' as const, evicted: [] };
    }
    const others = rows.filter((row) => row.appId !== appId);
    if (others.length + 1 > input.maxSlots) {
      const ids = others.map((row) => row.appId).sort((left, right) => (left < right ? -1 : 1));
      await tx
        .select({ id: apps.id })
        .from(apps)
        .where(inArray(apps.id, ids))
        .orderBy(asc(apps.id))
        .for('update');
      const authority = await tx
        .select()
        .from(appAuthority)
        .where(inArray(appAuthority.appId, ids))
        .orderBy(asc(appAuthority.appId))
        .for('update');
      const privileged = new Set(
        authority
          .filter(
            (row) =>
              (row.state === 'active' || row.state === 'draining') &&
              (!row.expiresAt || runtimeTimeMs(row.expiresAt) > Date.now()),
          )
          .map((row) => String(row.appId)),
      );
      const victims = others
        .filter((row) => row.status === 'ready' && !privileged.has(String(row.appId)))
        .sort((left, right) => runtimeTimeMs(left.lastActivityAt) - runtimeTimeMs(right.lastActivityAt))
        .slice(0, others.length + 1 - input.maxSlots)
        .map((row) => ({ appId: String(row.appId), containerId: row.containerId }));
      if (victims.length < others.length + 1 - input.maxSlots) {
        return { claim: 'full' as const, evicted: [] };
      }
      return { claim: 'evict' as const, evicted: victims };
    }
    await tx
      .insert(appRuntimes)
      .values({
        appId,
        runId: input.runId,
        containerId: '',
        containerName: input.containerName,
        port: input.port,
        imageIdentity: input.imageIdentity,
        workspaceRoot: input.workspaceRoot,
        status: 'starting',
        lockDigest: null,
        lastError: null,
        lastActivityAt: at,
        createTime: at,
        updateTime: at,
      })
      .onConflictDoUpdate({
        target: [appRuntimes.appId, appRuntimes.runId],
        set: {
          containerId: '',
          containerName: input.containerName,
          port: input.port,
          imageIdentity: input.imageIdentity,
          workspaceRoot: input.workspaceRoot,
          status: 'starting',
          lastError: null,
          lastActivityAt: at,
          updateTime: at,
        },
      });
    return { claim: 'reserved' as const, evicted: [] };
  });
}

/**
 * 把一台 runtime 标成已回收（槽位立即释放），返回它的容器标识供调用方停容器。
 * 条件更新让并发的回收/驱逐只有一个能生效，不会重复停同一个容器。
 */
export async function markAppRuntimeStopped(
  app: RuntimeApp,
  runId: string,
  error: string,
): Promise<string | null> {
  const [row] = await db()
    .update(appRuntimes)
    .set({ status: 'stopped', lastError: error.slice(0, 1000), updateTime: now() })
    .where(
      and(
        eq(appRuntimes.appId, appIdOf(app)),
        eq(appRuntimes.runId, runId),
        inArray(appRuntimes.status, ['starting', 'ready']),
      ),
    )
    .returning({ containerId: appRuntimes.containerId });
  return row?.containerId ?? null;
}

/** 批量读「哪些 App 正在持有写权限」：容量回收/驱逐一次查完，避免逐个 App 发查询。 */
export async function appsWithWriteAuthority(appIds: readonly string[]): Promise<Set<string>> {
  if (!appIds.length) return new Set();
  const rows = await db()
    .select({ appId: appAuthority.appId })
    .from(appAuthority)
    .where(
      and(
        inArray(
          appAuthority.appId,
          appIds.map((id) => BigInt(id)),
        ),
        inArray(appAuthority.state, ['active', 'draining']),
        sql`(${appAuthority.expiresAt} is null or ${appAuthority.expiresAt} > timezone('UTC', now()))`,
      ),
    );
  return new Set(rows.map((row) => String(row.appId)));
}

/** 写权限占用中（active/draining）的 App 不接受编辑：预览桥接据此锁住元素选择。 */
export async function appHasWriteAuthority(app: RuntimeApp): Promise<boolean> {
  const [row] = await db()
    .select({ state: appAuthority.state })
    .from(appAuthority)
    .where(
      and(eq(appAuthority.appId, appIdOf(app)), inArray(appAuthority.state, ['active', 'draining'])),
    )
    .limit(1);
  return row !== undefined;
}
