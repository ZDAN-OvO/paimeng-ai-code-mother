import 'server-only';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getConfig } from '../infra/config';
import { ensureSafeDirectory, projectAt } from '../workspace/workspace';
import { appTemplate } from '../workspace/template-workspace';
import { readTemplateFile, templateLockfile, templatePackageManager } from '../templates/templates';
import type { TemplateIdentity } from '@/shared/templates';
import {
  appNeedsRuntime, appRuntimeKey, devServerCommand, installCommand, lockfileDigest, runtimeContainerName,
  runtimeDockerfile, runtimeImageTag, runtimeMounts, runtimePaths, runtimePreviewBase, runtimeRunArgs,
  runtimeStorePath, RUNTIME_DEV_LOG, RUNTIME_DEV_PORT, type RuntimeApp,
} from './plan';
import { deleteAppRuntime, readAppRuntime, saveAppRuntime, touchAppRuntime, updateAppRuntime, type AppRuntimeRecord } from './store';

/**
 * 运行时容器唯一的启停者。
 *
 * 生命周期（#139 只覆盖「惰性创建 + 复用 + 明确状态」，回收/排队在 #144、对账在 #145）：
 *   生成开始 → ensureAppRuntime(app, 本次执行的源码根)
 *     有记录且容器还活着、源码根没换 → 复用它（dev server 还在就直接用）。
 *     否则用同一份 node_modules 与 pnpm store 重建容器，重新安装（锁文件或镜像身份变了才装）并启动 dev server。
 *   Preview → 读台账，把 HTTP 与 HMR websocket 代理到该端口。
 *
 * 失败不抛给生成：运行时不健康时记一条 `failed` 与可读原因，Preview 回落静态产物。
 */

const exec = promisify(execFile);
const DEFAULT_DOCKER_TIMEOUT = 60_000;

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

async function docker(args: string[], timeout = DEFAULT_DOCKER_TIMEOUT) {
  try {
    const result = await exec('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return (result.stdout ?? '').trim();
  } catch (error) {
    const detail = (error as { stderr?: string; stdout?: string }).stderr?.trim()
      || (error as { stdout?: string }).stdout?.trim() || (error as Error).message;
    throw new Error(`docker ${args[0]} 失败：${detail.slice(-1200)}`);
  }
}

/** `runtime/app-runtime` 是平台独占目录；ensureSafeDirectory 不递归建父目录，这里先补上。 */
async function runtimeBaseDirectory() {
  const base = join(getConfig().runtimeRoot, 'app-runtime');
  await mkdir(base, { recursive: true });
  return ensureSafeDirectory(base);
}

async function imageExists(tag: string) {
  try { await docker(['image', 'inspect', tag], 20_000); return true; } catch { return false; }
}

/** 固定镜像身份：基础镜像 + pnpm 版本决定标签，标签对应的镜像 ID 再做最终身份。 */
async function ensureRuntimeImage(): Promise<{ tag: string; identity: string }> {
  const config = getConfig();
  const tag = runtimeImageTag(config.appRuntime.image, config.appRuntime.pnpmVersion);
  const build = async () => {
    const directory = join(await runtimeBaseDirectory(), 'image');
    await ensureSafeDirectory(directory);
    await writeFile(join(directory, 'Dockerfile'), runtimeDockerfile(config.appRuntime.image, config.appRuntime.pnpmVersion), 'utf8');
    await docker(['build', '-t', tag, directory], Math.max(config.appRuntime.startTimeoutMs, 180_000));
  };
  if (!await imageExists(tag)) await build();
  let id: string;
  try { id = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], 20_000); }
  catch {
    // 标签被外部删掉了（例如 docker image prune）：重建一次，仍失败就按不可用处理。
    await build();
    id = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], 20_000);
  }
  return { tag, identity: `${tag}@${id.slice(0, 19)}` };
}

async function containerRunning(name: string): Promise<{ running: boolean; id: string | null; port: number | null }> {
  try {
    const id = await docker(['inspect', '--format', '{{.Id}}', name], 20_000).catch(() => '');
    if (!id) return { running: false, id: null, port: null };
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name], 20_000).then(value => value === 'true').catch(() => false);
    const published = running ? await docker(['port', name, `${RUNTIME_DEV_PORT}/tcp`], 20_000).catch(() => '') : '';
    const match = /:(\d+)\s*$/.exec(published);
    return { running, id, port: match ? Number(match[1]) : null };
  } catch { return { running: false, id: null, port: null }; }
}

async function removeContainer(name: string) {
  await docker(['rm', '-f', name], 30_000).catch(() => undefined);
}

function isConnectionRefused(error: unknown) {
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** dev server 是否已经在回应；只认 2xx/3xx，dev server 的 500 说明工程还没跑起来。 */
async function devServerResponding(port: number, base: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${base}`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    await response.arrayBuffer().catch(() => undefined);
    return response.status < 500;
  } catch (error) {
    if (!isConnectionRefused(error) && (error as Error).name !== 'TimeoutError' && (error as Error).name !== 'AbortError') log(`探测 dev server 失败：${(error as Error).message}`);
    return false;
  }
}

async function waitForDevServer(port: number, base: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await devServerResponding(port, base)) return true;
    await new Promise(done => setTimeout(done, 500));
  }
  return false;
}

async function projectTemplate(app: RuntimeApp, workspaceRoot: string): Promise<TemplateIdentity | null> {
  const template = await appTemplate(projectAt(app, workspaceRoot)).catch(() => null);
  return template ?? await appTemplate(app).catch(() => null);
}

function packageManagerOf(template: TemplateIdentity | null): 'npm' | 'pnpm' | null {
  if (!template) return null;
  try { return templatePackageManager(template); } catch { return null; }
}

async function lockfileOf(app: RuntimeApp, workspaceRoot: string, template: TemplateIdentity | null): Promise<{ digest: string } | null> {
  if (!template || !packageManagerOf(template)) return null;
  const name = templateLockfile(template);
  try {
    return { digest: lockfileDigest(await readFile(join(workspaceRoot, name))) };
  } catch {
    // 新执行目录可能还没把锁文件复制进来（或旧应用没有）：用模板锁文件算同一个指纹。
    const fallback = await readTemplateFile(template, name).catch(() => null);
    return fallback ? { digest: lockfileDigest(Buffer.from(fallback)) } : null;
  }
}

async function startDevServer(app: RuntimeApp, workspaceRoot: string, template: TemplateIdentity | null, port: number) {
  const base = runtimePreviewBase(app);
  const command = devServerCommand({ template, basePath: base });
  if (!command) return false;
  const script = `${command.map(part => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')} > ${RUNTIME_DEV_LOG} 2>&1`;
  await docker(['exec', '-d', runtimeContainerName(app), 'sh', '-lc', script], 30_000);
  const ready = await waitForDevServer(port, base, getConfig().appRuntime.devReadyTimeoutMs);
  if (!ready) {
    const tail = await docker(['exec', runtimeContainerName(app), 'sh', '-lc', `tail -c 1200 ${RUNTIME_DEV_LOG} 2>/dev/null || true`], 20_000).catch(() => '');
    throw new Error(`开发服务器没有在 ${Math.round(getConfig().appRuntime.devReadyTimeoutMs / 1000)} 秒内响应${tail ? `：${tail.slice(-600)}` : ''}`);
  }
  return true;
}

async function installDependencies(app: RuntimeApp, workspaceRoot: string, template: TemplateIdentity | null) {
  const packageManager = packageManagerOf(template);
  if (!packageManager) return;
  const lock = await lockfileOf(app, workspaceRoot, template);
  const command = installCommand({ packageManager, hasLockfile: lock !== null });
  await docker(['exec', '-w', '/work', runtimeContainerName(app), ...command], getConfig().appRuntime.startTimeoutMs);
}

async function createContainer(app: RuntimeApp, workspaceRoot: string, image: string, identity: string): Promise<AppRuntimeRecord> {
  const config = getConfig();
  const template = await projectTemplate(app, workspaceRoot);
  await runtimeBaseDirectory();
  const paths = runtimePaths(config.runtimeRoot, app);
  await ensureSafeDirectory(paths.base);
  await ensureSafeDirectory(paths.nodeModules);
  await ensureSafeDirectory(runtimeStorePath(config.runtimeRoot));
  const name = runtimeContainerName(app);
  const mountList = runtimeMounts({
    workspaceRoot,
    nodeModulesRoot: paths.nodeModules,
    storeRoot: runtimeStorePath(config.runtimeRoot),
  });
  await removeContainer(name);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  await docker(runtimeRunArgs({
    app, image, uid, gid, mounts: mountList, registry: config.buildNpmRegistry,
  }), config.appRuntime.startTimeoutMs);
  const state = await containerRunning(name);
  if (!state.running || !state.id || !state.port) throw new Error('运行时容器没有启动成功');
  const lock = await lockfileOf(app, workspaceRoot, template);
  let record = await saveAppRuntime(app, {
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
    if (packageManagerOf(template)) {
      await installDependencies(app, workspaceRoot, template);
      await updateAppRuntime(app, { lockDigest: lock?.digest ?? null });
    }
    await startDevServer(app, workspaceRoot, template, state.port);
    record = (await readAppRuntime(app))!;
    await updateAppRuntime(app, { status: 'ready', lastError: null });
    return { ...record, status: 'ready', lockDigest: lock?.digest ?? null, lastError: null };
  } catch (error) {
    const detail = (error as Error).message.slice(0, 1000);
    await updateAppRuntime(app, { status: 'failed', lastError: detail }).catch(() => undefined);
    await removeContainer(name).catch(() => undefined);
    throw new Error(detail);
  }
}

const chains = new Map<string, Promise<RuntimeView>>();

async function ensureUnlocked(app: RuntimeApp, workspaceRoot: string): Promise<RuntimeView> {
  const config = getConfig();
  if (!config.appRuntime.enabled || !appNeedsRuntime(app)) {
    return { app, status: 'disabled', port: null, containerId: null, workspaceRoot: null, imageIdentity: null, lastActivityAt: null, error: null };
  }
  const existing = await readAppRuntime(app);
  const name = runtimeContainerName(app);
  if (existing) {
    const state = await containerRunning(existing.containerName);
    if (state.running && existing.workspaceRoot === workspaceRoot) {
      const template = await projectTemplate(app, workspaceRoot);
      const base = runtimePreviewBase(app);
      if (state.port && await devServerResponding(state.port, base)) {
        await touchAppRuntime(app);
        await updateAppRuntime(app, { status: 'ready', port: state.port, lastError: null });
        return { app, status: 'ready', port: state.port, containerId: existing.containerId, workspaceRoot: existing.workspaceRoot, imageIdentity: existing.imageIdentity, lastActivityAt: existing.lastActivityAt, error: null };
      }
      // 容器在但 dev server 掉了（崩溃/上一轮还没起来）：先尝试原地拉起，不行再重建。
      if (state.port) {
        try {
          const lock = await lockfileOf(app, workspaceRoot, template);
          if (lock && lock.digest !== existing.lockDigest) await installDependencies(app, workspaceRoot, template);
          await startDevServer(app, workspaceRoot, template, state.port);
          await updateAppRuntime(app, { status: 'ready', port: state.port, lockDigest: lock?.digest ?? existing.lockDigest, lastError: null });
          await touchAppRuntime(app);
          return { app, status: 'ready', port: state.port, containerId: existing.containerId, workspaceRoot: existing.workspaceRoot, imageIdentity: existing.imageIdentity, lastActivityAt: existing.lastActivityAt, error: null };
        } catch (error) {
          log(`dev server 未能原地恢复，重建 runtime（应用 ${app.id}）：${(error as Error).message}`);
        }
      }
    }
    await removeContainer(existing.containerName);
    await deleteAppRuntime(app).catch(() => undefined);
  }
  const image = await ensureRuntimeImage();
  try {
    const record = await createContainer(app, workspaceRoot, image.tag, image.identity);
    return {
      app, status: 'ready', port: record.port, containerId: record.containerId, workspaceRoot: record.workspaceRoot,
      imageIdentity: record.imageIdentity, lastActivityAt: record.lastActivityAt, error: null,
    };
  } catch (error) {
    const detail = (error as Error).message.slice(0, 1000);
    await saveAppRuntime(app, {
      containerId: '', containerName: name, port: RUNTIME_DEV_PORT, imageIdentity: image.identity,
      workspaceRoot, status: 'failed', lockDigest: null, lastError: detail,
    }).catch(() => undefined);
    log(`应用 ${app.id} 的 runtime 启动失败：${detail}`);
    return {
      app, status: 'failed', port: null, containerId: null, workspaceRoot,
      imageIdentity: image.identity, lastActivityAt: null, error: detail,
    };
  }
}

/** 生成开始时惰性唤醒；同一个 App 的并发调用排队，避免两台容器同时挂同一份源码。 */
export async function ensureAppRuntime(input: { app: RuntimeApp; workspaceRoot: string }): Promise<RuntimeView> {
  const { app, workspaceRoot } = input;
  if (!appNeedsRuntime(app)) {
    return { app, status: 'disabled', port: null, containerId: null, workspaceRoot: null, imageIdentity: null, lastActivityAt: null, error: null };
  }
  const key = appRuntimeKey(app);
  const previous = chains.get(key) ?? Promise.resolve({
    app, status: 'disabled', port: null, containerId: null, workspaceRoot: null, imageIdentity: null, lastActivityAt: null, error: null,
  } as RuntimeView);
  const next = previous.catch(() => undefined).then(() => ensureUnlocked(app, workspaceRoot));
  chains.set(key, next);
  try { return await next; }
  finally { if (chains.get(key) === next) chains.delete(key); }
}

/** 停止并忘记这个 App 的 runtime；容器与台账都不留。 */
export async function stopAppRuntime(app: RuntimeApp): Promise<void> {
  await removeContainer(runtimeContainerName(app));
  await deleteAppRuntime(app);
}

/**
 * 预览进程用的解析器：只信「ready + 端口 + 容器还活着」的台账，并做一次轻量 TCP/HTTP 探测。
 * 没有任何记录返回 null，交给静态产物回落；有记录但没 ready 时返回状态，预览给出明确提示。
 */
export async function runtimePreviewTarget(app: RuntimeApp): Promise<{ status: 'ready' | 'starting' | 'failed'; port: number | null } | null> {
  if (!appNeedsRuntime(app)) return null;
  const record = await readAppRuntime(app);
  if (!record) return null;
  if (record.status === 'ready' && await devServerResponding(record.port, runtimePreviewBase(app))) {
    return { status: 'ready', port: record.port };
  }
  if (record.status === 'ready' || record.status === 'starting') return { status: 'starting', port: null };
  return { status: 'failed', port: null };
}

/** 应用当前的 Preview 是否由 dev server 提供（业务层据此在构建产物出现前就给出预览 URL）。 */
export async function runtimePreviewAvailable(app: RuntimeApp): Promise<boolean> {
  const target = await runtimePreviewTarget(app).catch(() => null);
  return target?.status === 'ready';
}

/** 生成开始前调用：运行时不可用时只记日志，生成继续按静态产物收尾。 */
export async function prepareGenerationRuntime(input: { app: RuntimeApp; workspaceRoot: string }): Promise<void> {
  try {
    const view = await ensureAppRuntime(input);
    if (view.status === 'failed') log(`生成继续，但实时预览不可用（应用 ${input.app.id}）：${view.error ?? '未知原因'}`);
  } catch (error) {
    log(`准备 runtime 失败（应用 ${input.app.id}）：${(error as Error).message}`);
  }
}
