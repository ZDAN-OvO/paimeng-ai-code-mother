import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db, now } from '../infra/db';
import { appAuthority, appRuntimes, type AppRuntimeStatus } from '../infra/schema';
import { idSchema } from '@/shared/contracts';
import type { RuntimeApp } from './plan';

/**
 * App runtime 的持久台账（migrations/023_app_runtime.sql）。
 *
 * 一行代表「平台认为某 App 的 runtime 是哪台容器」。容器本身的事实由 Docker 持有；
 * 这张表只记录容器标识、dev server 端口、挂载的源码根、镜像身份与最后活动时间，
 * 供预览进程解析代理目标、供后续任务做回收/对账（#144/#145）。
 */

export type AppRuntimeRecord = {
  appId: string;
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

export async function readAppRuntime(app: RuntimeApp): Promise<AppRuntimeRecord | null> {
  const [row] = await db().select().from(appRuntimes).where(eq(appRuntimes.appId, appIdOf(app))).limit(1);
  return row ? view(row) : null;
}

export async function saveAppRuntime(app: RuntimeApp, input: {
  containerId: string;
  containerName: string;
  port: number;
  imageIdentity: string;
  workspaceRoot: string;
  status: AppRuntimeStatus;
  lockDigest: string | null;
  lastError: string | null;
  lastActivityAt?: string;
}): Promise<AppRuntimeRecord> {
  const at = input.lastActivityAt ?? now();
  const [row] = await db().insert(appRuntimes).values({
    appId: appIdOf(app),
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
  }).onConflictDoUpdate({
    target: appRuntimes.appId,
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
  }).returning();
  return view(row);
}

export async function updateAppRuntime(app: RuntimeApp, patch: {
  status?: AppRuntimeStatus;
  port?: number;
  containerId?: string;
  lockDigest?: string | null;
  lastError?: string | null;
  lastActivityAt?: string;
}): Promise<void> {
  const at = patch.lastActivityAt ?? now();
  await db().update(appRuntimes).set({ ...patch, updateTime: at }).where(eq(appRuntimes.appId, appIdOf(app)));
}

/** 活动时间只前移：同一毫秒内的重复写入不值得多一次表更新。 */
export async function touchAppRuntime(app: RuntimeApp, at = now()): Promise<void> {
  await db().update(appRuntimes).set({ lastActivityAt: at, updateTime: at }).where(eq(appRuntimes.appId, appIdOf(app)));
}

export async function deleteAppRuntime(app: RuntimeApp): Promise<void> {
  await db().delete(appRuntimes).where(eq(appRuntimes.appId, appIdOf(app)));
}

/** 写权限占用中（active/draining）的 App 不接受编辑：预览桥接据此锁住元素选择。 */
export async function appHasWriteAuthority(app: RuntimeApp): Promise<boolean> {
  const [row] = await db().select({ state: appAuthority.state }).from(appAuthority)
    .where(and(eq(appAuthority.appId, appIdOf(app)), inArray(appAuthority.state, ['active', 'draining']))).limit(1);
  return row !== undefined;
}
