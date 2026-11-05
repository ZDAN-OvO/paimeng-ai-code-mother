import 'server-only';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig } from '../infra/config';
import { ensureSafeDirectory, workspace } from '../workspace/workspace';
import {
  appNeedsRuntime,
  appRuntimeKey,
  devServerCommand,
  runtimeBuildArgs,
  runtimeContainerName,
  runtimeImageTag,
  runtimeMounts,
  runtimePreviewBase,
  runtimeRunArgs,
  runtimeStorePath,
  runtimeVirtualStore,
  RUNTIME_DOCKER_CONTEXT,
  RUNTIME_DOCKERFILE,
  RUNTIME_DEV_LOG,
  RUNTIME_DEV_PORT,
  type RuntimeApp,
} from './plan';
import {
  appsWithWriteAuthority,
  deleteAppRuntime,
  listAppRuntimes,
  markAppRuntimeStopped,
  readAppRuntime,
  saveAppRuntime,
  touchAppRuntime,
  updateAppRuntime,
  type AppRuntimeRecord,
} from './store';
import { anonymousMemoryBytes, evictionVictim, idleRuntimes, type RuntimeCandidate } from './capacity';
import {
  buildImage,
  containerState,
  docker,
  imageExists,
  imageId,
  listManagedContainers,
  removeContainer,
} from './container';
import { assertDependencySources, ensureDependencies } from './dependencies';
import { runInRuntime, startDetached } from './commands';

/**
 * 运行时容器唯一的启停者。
 *
 *   生成开始 → ensureAppRuntime(app, 持久 Workspace)
 *     容器与镜像身份仍有效 → 原地复用，锁文件变化时在同一容器内重新安装。
 *     容器故障或镜像身份变化 → 重建；源码与 node_modules 始终留在同一份 Workspace。
 *   Preview → 读台账，把 HTTP 与 HMR websocket 代理到该端口。
 *
 * 失败不抛给生成：运行时不健康时记一条 `failed` 与可读原因，Preview 回落静态产物。
 * 常驻循环挂在 harness 进程里，Next 进程不直接调 Docker。
 */

export type RuntimeView = {
  app: RuntimeApp;
  status: AppRuntimeRecord['status'] | 'disabled';
  port: number | null;
  containerId: string | null;
  workspaceRoot: string | null;
  imageIdentity: string | null;
  lastActivityAt: string | null;
  error: string | null;
};

function log(message: string) {
  console.warn(`[app-runtime] ${message}`);
}

/** `runtime/app-runtime` 是平台独占目录；ensureSafeDirectory 不递归建父目录，这里先补上。 */
async function runtimeBaseDirectory() {
  const base = join(getConfig().runtimeRoot, 'app-runtime');
  await mkdir(base, { recursive: true });
  return ensureSafeDirectory(base);
}

/** 固定镜像身份：基础镜像 + pnpm 版本决定标签，标签对应的镜像 ID 再做最终身份。 */
async function ensureRuntimeImage(): Promise<{ tag: string; identity: string }> {
  const config = getConfig();
  const tag = runtimeImageTag(config.appRuntime.image, config.appRuntime.pnpmVersion);
  const build = async () => {
    await buildImage({
      tag,
      context: resolve(RUNTIME_DOCKER_CONTEXT),
      dockerfile: resolve(RUNTIME_DOCKERFILE),
      buildArgs: runtimeBuildArgs({
        image: config.appRuntime.image,
        pnpmVersion: config.appRuntime.pnpmVersion,
      }),
      timeoutMs: Math.max(config.appRuntime.startTimeoutMs, 180_000),
    });
  };
  if (!(await imageExists(tag))) await build();
  let id: string;
  try {
    id = await imageId(tag);
  } catch {
    // 标签被外部删掉了（例如 docker image prune）：重建一次，仍失败就按不可用处理。
    await build();
    id = await imageId(tag);
  }
  return { tag, identity: `${tag}@${id.slice(0, 19)}` };
}

function isConnectionRefused(error: unknown) {
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes(
    (error as NodeJS.ErrnoException)?.code ?? '',
  );
}

/** dev server 是否已经在回应；只认 2xx/3xx，dev server 的 500 说明工程还没跑起来。 */
async function devServerResponding(port: number, base: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${base}`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status < 500;
  } catch (error) {
    const name = (error as Error).name;
    if (!isConnectionRefused(error) && name !== 'TimeoutError' && name !== 'AbortError') {
      log(`探测 dev server 失败：${(error as Error).message}`);
    }
    return false;
  }
}

async function waitForDevServer(port: number, base: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await devServerResponding(port, base)) return true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

async function startDevServer(app: RuntimeApp, port: number) {
  const base = runtimePreviewBase(app);
  const command = devServerCommand({ basePath: base });
  const script = `${command.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')} > ${RUNTIME_DEV_LOG} 2>&1`;
  await startDetached({ container: runtimeContainerName(app), script, workdir: '/work' });
  const ready = await waitForDevServer(port, base, getConfig().appRuntime.devReadyTimeoutMs);
  if (!ready) {
    const tail = await runInRuntime({
      container: runtimeContainerName(app),
      command: ['tail', '-c', '1200', RUNTIME_DEV_LOG],
      timeoutMs: 20_000,
    }).catch(() => null);
    const detail = tail && tail.exitCode === 0 ? tail.output.trim().slice(-600) : '';
    throw new Error(
      `开发服务器没有在 ${Math.round(getConfig().appRuntime.devReadyTimeoutMs / 1000)} 秒内响应${detail ? `：${detail}` : ''}`,
    );
  }
}

/** 安装前先验来源；安装本身由 dependencies 维护 image+lock 配对。 */
async function installDependencies(input: {
  app: RuntimeApp;
  workspaceRoot: string;
  imageIdentity: string;
}) {
  await assertDependencySources(input.workspaceRoot);
  return ensureDependencies({
    app: input.app,
    workspaceRoot: input.workspaceRoot,
    container: runtimeContainerName(input.app),
    imageIdentity: input.imageIdentity,
    timeoutMs: getConfig().appRuntime.startTimeoutMs,
  });
}

async function createContainer(
  app: RuntimeApp,
  workspaceRoot: string,
  image: string,
  identity: string,
): Promise<AppRuntimeRecord> {
  const config = getConfig();
  await runtimeBaseDirectory();
  await ensureSafeDirectory(runtimeStorePath(config.runtimeRoot));
  const name = runtimeContainerName(app);
  const mounts = runtimeMounts({ workspaceRoot, storeRoot: runtimeStorePath(config.runtimeRoot) });
  await removeContainer(name);
  const { uid, gid } = await stat(workspaceRoot);
  await docker(
    runtimeRunArgs({
      app,
      image,
      uid,
      gid,
      mounts,
      registry: config.buildNpmRegistry,
      virtualStore: runtimeVirtualStore(app),
    }),
    config.appRuntime.startTimeoutMs,
  );
  const state = await containerState(name, RUNTIME_DEV_PORT);
  if (!state.running || !state.id || !state.port) throw new Error('运行时容器没有启动成功');
  await saveAppRuntime(app, {
    containerId: state.id,
    containerName: name,
    port: state.port,
    imageIdentity: identity,
    workspaceRoot,
    status: 'starting',
    lockDigest: null,
    lastError: null,
  });
  try {
    const installed = await installDependencies({ app, workspaceRoot, imageIdentity: identity });
    await updateAppRuntime(app, { lockDigest: installed.pair.lockDigest });
    await startDevServer(app, state.port);
    await updateAppRuntime(app, { status: 'ready', lastError: null });
    return { ...(await readAppRuntime(app))!, status: 'ready', lastError: null };
  } catch (error) {
    const detail = (error as Error).message.slice(0, 1000);
    await updateAppRuntime(app, { status: 'failed', lastError: detail }).catch(() => undefined);
    await removeContainer(name).catch(() => undefined);
    throw new Error(detail);
  }
}

const chains = new Map<string, Promise<RuntimeView>>();

const disabled = (app: RuntimeApp): RuntimeView => ({
  app,
  status: 'disabled',
  port: null,
  containerId: null,
  workspaceRoot: null,
  imageIdentity: null,
  lastActivityAt: null,
  error: null,
});

async function ensureUnlocked(app: RuntimeApp, workspaceRoot: string): Promise<RuntimeView> {
  const config = getConfig();
  if (!config.appRuntime.enabled || !appNeedsRuntime(app)) return disabled(app);
  const image = await ensureRuntimeImage();
  const existing = await readAppRuntime(app);
  const name = runtimeContainerName(app);
  if (existing) {
    const state = await containerState(existing.containerName, RUNTIME_DEV_PORT);
    if (state.running && existing.workspaceRoot === workspaceRoot && existing.imageIdentity === image.identity) {
      const base = runtimePreviewBase(app);
      try {
        const installed = await installDependencies({ app, workspaceRoot, imageIdentity: image.identity });
        if (installed.installed) await updateAppRuntime(app, { status: 'starting', lastError: null });
        await updateAppRuntime(app, { lockDigest: installed.pair.lockDigest });
      } catch (error) {
        const detail = (error as Error).message.slice(0, 1000);
        await updateAppRuntime(app, { status: 'failed', lastError: detail });
        log(`应用 ${app.id} 的依赖重装失败：${detail}`);
        return {
          app,
          status: 'failed',
          port: null,
          containerId: state.id,
          workspaceRoot,
          imageIdentity: image.identity,
          lastActivityAt: existing.lastActivityAt,
          error: detail,
        };
      }
      if (state.port && (await devServerResponding(state.port, base))) {
        await touchAppRuntime(app);
        await updateAppRuntime(app, { status: 'ready', port: state.port, lastError: null });
        return {
          app,
          status: 'ready',
          port: state.port,
          containerId: existing.containerId,
          workspaceRoot: existing.workspaceRoot,
          imageIdentity: existing.imageIdentity,
          lastActivityAt: existing.lastActivityAt,
          error: null,
        };
      }
      // 容器在但 dev server 掉了（崩溃/上一轮还没起来）：先尝试原地拉起，不行再重建。
      if (state.port) {
        try {
          await startDevServer(app, state.port);
          await updateAppRuntime(app, {
            status: 'ready',
            port: state.port,
            lockDigest: existing.lockDigest,
            lastError: null,
          });
          await touchAppRuntime(app);
          return {
            app,
            status: 'ready',
            port: state.port,
            containerId: existing.containerId,
            workspaceRoot: existing.workspaceRoot,
            imageIdentity: existing.imageIdentity,
            lastActivityAt: existing.lastActivityAt,
            error: null,
          };
        } catch (error) {
          log(`dev server 未能原地恢复，重建 runtime（应用 ${app.id}）：${(error as Error).message}`);
        }
      }
    }
    await removeContainer(existing.containerName);
    await deleteAppRuntime(app).catch(() => undefined);
  }
  try {
    const record = await createContainer(app, workspaceRoot, image.tag, image.identity);
    return {
      app,
      status: 'ready',
      port: record.port,
      containerId: record.containerId,
      workspaceRoot: record.workspaceRoot,
      imageIdentity: record.imageIdentity,
      lastActivityAt: record.lastActivityAt,
      error: null,
    };
  } catch (error) {
    const detail = (error as Error).message.slice(0, 1000);
    await saveAppRuntime(app, {
      containerId: '',
      containerName: name,
      port: RUNTIME_DEV_PORT,
      imageIdentity: image.identity,
      workspaceRoot,
      status: 'failed',
      lockDigest: null,
      lastError: detail,
    }).catch(() => undefined);
    log(`应用 ${app.id} 的 runtime 启动失败：${detail}`);
    return {
      app,
      status: 'failed',
      port: null,
      containerId: null,
      workspaceRoot,
      imageIdentity: image.identity,
      lastActivityAt: null,
      error: detail,
    };
  }
}

/** 生成开始时惰性唤醒；同一个 App 的并发调用排队，避免两台容器同时挂同一份源码。 */
export async function ensureAppRuntime(input: {
  app: RuntimeApp;
  workspaceRoot: string;
}): Promise<RuntimeView> {
  const { app, workspaceRoot } = input;
  if (workspaceRoot !== workspace(app)) throw new Error('运行时只能挂载 App 的持久 Workspace');
  if (!appNeedsRuntime(app)) return disabled(app);
  const key = appRuntimeKey(app);
  const previous = chains.get(key) ?? Promise.resolve(disabled(app));
  const next = previous.catch(() => undefined).then(() => ensureUnlocked(app, workspaceRoot));
  chains.set(key, next);
  try {
    return await next;
  } finally {
    if (chains.get(key) === next) chains.delete(key);
  }
}

/** 停止并忘记这个 App 的 runtime；容器与台账都不留。 */
export async function stopAppRuntime(app: RuntimeApp): Promise<void> {
  await removeContainer(runtimeContainerName(app));
  await deleteAppRuntime(app);
}

/**
 * 预览进程用的解析器：只信「ready + 端口 + dev server 还活着」的台账，并做一次轻量 HTTP 探测。
 * 没有任何记录返回 null，交给静态产物回落；有记录但没 ready 时返回状态，预览给出明确提示。
 */
export async function runtimePreviewTarget(
  app: RuntimeApp,
): Promise<{ status: 'ready' | 'starting' | 'failed'; port: number | null } | null> {
  if (!appNeedsRuntime(app)) return null;
  const record = await readAppRuntime(app);
  if (!record) return null;
  if (record.status === 'ready' && (await devServerResponding(record.port, runtimePreviewBase(app)))) {
    return { status: 'ready', port: record.port };
  }
  // 已回收（睡眠）的 runtime 不再占有预览：交给静态产物回落，查看 Preview 不会唤醒它。
  if (record.status === 'stopped') return null;
  if (record.status === 'ready' || record.status === 'starting') return { status: 'starting', port: null };
  return { status: 'failed', port: null };
}

/** 应用当前的 Preview 是否由 dev server 提供（业务层据此在构建产物出现前就给出预览 URL）。 */
export async function runtimePreviewAvailable(app: RuntimeApp): Promise<boolean> {
  const target = await runtimePreviewTarget(app).catch(() => null);
  return target?.status === 'ready';
}

/** 生成开始前调用：运行时不可用时只记日志，生成继续按静态产物收尾。 */
export async function prepareGenerationRuntime(input: {
  app: RuntimeApp;
  workspaceRoot: string;
}): Promise<void> {
  try {
    const view = await ensureAppRuntime(input);
    if (view.status === 'failed') {
      log(`生成继续，但实时预览不可用（应用 ${input.app.id}）：${view.error ?? '未知原因'}`);
    }
  } catch (error) {
    log(`准备 runtime 失败（应用 ${input.app.id}）：${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// 对账与容量：标签对账、空闲回收、LRU 驱逐
// ---------------------------------------------------------------------------------------------------

/**
 * 容器与台账对账：只按平台标签认容器。
 *   台账说在跑、容器没了 → 标 stopped，下一次生成惰性重建。
 *   容器在跑、台账里没有它的 App → 孤儿，直接删（平台自己的，不碰别人的容器）。
 */
export async function reconcileRuntime(): Promise<{ orphaned: string[]; stopped: string[] }> {
  const config = getConfig();
  if (!config.appRuntime.enabled) return { orphaned: [], stopped: [] };
  const containers = await listManagedContainers('paimeng.managed-by').catch(() => []);
  const rows = await listAppRuntimes(['starting', 'ready']);
  const known = new Map(rows.map((row) => [`${row.containerName}`, row]));
  const live = new Set(containers.map((container) => container.name));
  const orphaned: string[] = [];
  for (const container of containers) {
    if (container.appKey && !known.has(container.name)) {
      await removeContainer(container.id);
      orphaned.push(container.appKey);
    }
  }
  const stopped: string[] = [];
  for (const row of rows) {
    if (live.has(row.containerName)) continue;
    const released = await markAppRuntimeStopped({ id: row.appId, codeGenType: 'react_project' }, '容器已不存在，等待下一次生成重建');
    if (released !== null) stopped.push(row.appId);
  }
  return { orphaned, stopped };
}

async function capacityCandidates(): Promise<RuntimeCandidate[]> {
  const records = await listAppRuntimes(['starting', 'ready']);
  if (!records.length) return [];
  const privileged = await appsWithWriteAuthority(records.map((record) => record.appId));
  return records.map((record) => ({
    appId: record.appId,
    status: record.status as 'starting' | 'ready',
    lastActivityAt: record.lastActivityAt,
    writeAuthority: privileged.has(record.appId),
  }));
}

/** 停掉一台 runtime：先条件更新状态（槽位立即释放），再按容器标识停容器，名字被复用时也不会误杀。 */
async function stopRuntimeForCapacity(app: RuntimeApp, error: string): Promise<boolean> {
  const containerId = await markAppRuntimeStopped(app, error);
  if (containerId === null) return false;
  if (containerId) {
    await docker(['rm', '-f', containerId], 30_000).catch((problem) =>
      log(`停止 runtime 容器失败（应用 ${app.id}）：${(problem as Error).message}`),
    );
  }
  log(`回收 runtime（应用 ${app.id}）：${error}`);
  return true;
}

/** 连续空闲超过 RUNTIME_IDLE_TIMEOUT_MS 的 App 让出槽位；持有写权限的一律跳过。 */
export async function reclaimIdleRuntimes(): Promise<string[]> {
  const config = getConfig();
  if (!config.appRuntime.enabled) return [];
  const idle = idleRuntimes(await capacityCandidates(), Date.now(), config.appRuntime.idleTimeoutMs);
  const reclaimed: string[] = [];
  for (const candidate of idle) {
    const stopped = await stopRuntimeForCapacity(
      { id: candidate.appId, codeGenType: 'react_project' },
      '空闲超时，已回收运行时',
    ).catch(() => false);
    if (stopped) reclaimed.push(candidate.appId);
  }
  return reclaimed;
}

/** 超出槽位上限时按 LRU 驱逐没有写权限的 runtime。 */
export async function evictOverCapacityRuntimes(): Promise<string[]> {
  const config = getConfig();
  if (!config.appRuntime.enabled) return [];
  const evicted: string[] = [];
  for (;;) {
    const rows = await listAppRuntimes(['starting', 'ready']);
    if (rows.length <= config.appRuntime.maxSlots) break;
    const victim = evictionVictim(await capacityCandidates(), new Set(evicted));
    if (!victim) break;
    const stopped = await stopRuntimeForCapacity(
      { id: victim.appId, codeGenType: 'react_project' },
      '为新的运行时让出槽位',
    ).catch(() => false);
    if (!stopped) break;
    evicted.push(victim.appId);
  }
  return evicted;
}

export type CapacityOutcome = { reclaimed: string[]; evicted: string[]; orphaned: string[]; stopped: string[] };

/** 一次容量维护：对账 → 回收空闲 → 超限驱逐。常驻 tick 与测试共用。 */
export async function maintainRuntimeCapacity(): Promise<CapacityOutcome> {
  // 没有 runtime 的进程不为「对账」每 5 秒跑一次 docker ps；启动时已经对过一次账。
  const rows = await listAppRuntimes(['starting', 'ready']);
  if (!rows.length) return { reclaimed: [], evicted: [], orphaned: [], stopped: [] };
  const reconciliation = await reconcileRuntime();
  const reclaimed = await reclaimIdleRuntimes();
  const evicted = await evictOverCapacityRuntimes();
  return { ...reconciliation, reclaimed, evicted };
}

let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

/** 懒启动的常驻 tick：只在真的用到 runtime 的进程里跑，不阻塞进程退出。 */
export function startRuntimeMaintenance(): void {
  if (maintenanceTimer) return;
  const config = getConfig();
  if (!config.appRuntime.enabled) return;
  // 启动先对一次账：上个进程退出时留下的容器与台账在这里收束。
  void reconcileRuntime().catch((problem) => log(`启动对账失败：${(problem as Error).message}`));
  maintenanceTimer = setInterval(() => {
    void maintainRuntimeCapacity().catch((problem) =>
      log(`容量维护失败：${(problem as Error).message}`),
    );
  }, config.appRuntime.tickMs);
  maintenanceTimer.unref?.();
}

/** 测试收尾用：停掉常驻 tick，避免配置跨用例串场。 */
export function stopRuntimeMaintenance(): void {
  if (!maintenanceTimer) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = undefined;
}

export async function runtimeCapacitySnapshot(): Promise<{
  used: number;
  limit: number;
  idleTimeoutMs: number;
}> {
  const config = getConfig();
  const rows = await listAppRuntimes(['starting', 'ready']);
  return { used: rows.length, limit: config.appRuntime.maxSlots, idleTimeoutMs: config.appRuntime.idleTimeoutMs };
}

/** 单个 runtime 的匿名内存用量（字节），用于容量观察；读不到返回 null。 */
export async function readRuntimeAnonymousMemory(app: RuntimeApp): Promise<number | null> {
  const record = await readAppRuntime(app);
  if (!record || record.status !== 'ready' || !record.containerId) return null;
  const stat = await runInRuntime({
    container: record.containerId,
    command: [
      'sh',
      '-lc',
      'cat /sys/fs/cgroup/memory.stat 2>/dev/null || cat /sys/fs/cgroup/memory/memory.stat 2>/dev/null || true',
    ],
    timeoutMs: 10_000,
    outputBytes: 64 * 1024,
  }).catch(() => null);
  return stat ? anonymousMemoryBytes(stat.output) : null;
}
