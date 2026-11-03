import 'server-only';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../infra/config';
import { appTemplate } from '../workspace/template-workspace';
import { projectAt } from '../workspace/workspace';
import { templatePackageManager } from '../templates/templates';
import { markBuildFailure, sourceFailure } from '../delivery/build-feedback';
import { assertNoNpmrc, assertRegistryDependencies, DependencySourceError } from '../delivery/dependency-policy';
import { ensureAppRuntime, recordDependenciesInstalled } from './supervisor';
import { runRuntimeShell, type RuntimeShellResult } from './shell';
import { runtimeVirtualStore, RUNTIME_STORE, type RuntimeApp } from './plan';

/**
 * 轮末依赖归一化（#140）：模型可以用 shell 自己 `pnpm add`，平台不再逐字节锁模板依赖。
 * 每轮平台验证前在 App runtime 内做一次：
 *   1. 工程里不允许 .npmrc，清单与锁文件只接受 registry 来源；
 *   2. `pnpm install --lockfile-only` 让锁文件与 package.json 对齐；
 *   3. 再按归一化后的锁文件校验来源，并用 `--frozen-lockfile` 真正安装；
 *   4. 记下「镜像身份 + 锁文件哈希」的安装标记，下一轮复用，不必为了同一个锁文件重装。
 *
 * 对齐/安装失败会明确终止这一轮的产物：错误带 stage，和构建失败一起交给现有的分类与诊断。
 */

export class DependencyFinalizeError extends Error {
  constructor(message: string, readonly stage: 'source' | 'install') {
    super(message);
    this.name = 'DependencyFinalizeError';
  }
}

function normalizeCommand(app: RuntimeApp) {
  return `pnpm install --lockfile-only --ignore-scripts --reporter=append-only --store-dir=${RUNTIME_STORE} --virtual-store-dir=${runtimeVirtualStore(app)}`;
}
function frozenInstallCommand(app: RuntimeApp) {
  return `pnpm install --frozen-lockfile --ignore-scripts --reporter=append-only --store-dir=${RUNTIME_STORE} --virtual-store-dir=${runtimeVirtualStore(app)}`;
}

async function npmrcFiles(root: string): Promise<string[]> {
  try { await lstat(join(root, '.npmrc')); return ['.npmrc']; }
  catch { return []; }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function installFailure(label: string, result: RuntimeShellResult): DependencyFinalizeError {
  const detail = result.output.trim().slice(-1200);
  if (/ERR_PNPM_OUTDATED_LOCKFILE/.test(result.output)) {
    return new DependencyFinalizeError(
      `package.json 与 pnpm-lock.yaml 无法对齐：pnpm 拒绝按当前锁文件安装。请重新安装依赖，让锁文件和清单一致。\n${detail}`,
      'install',
    );
  }
  if (result.timedOut) {
    return new DependencyFinalizeError(`依赖${label}超时：容器内的 pnpm 没有在预算内完成，已按进程组终止。\n${detail}`, 'install');
  }
  return new DependencyFinalizeError(`依赖${label}失败：\n${detail || `退出码 ${result.exitCode}`}`, 'install');
}

export async function finalizeRuntimeDependencies(input: {
  app: RuntimeApp;
  workspaceRoot: string;
  signal?: AbortSignal;
  /** 测试缝：替换「取 runtime」这一步，用来验证运行时不可用时不会把未检查当成功。 */
  runtime?: () => Promise<{ status: string; error?: string | null }>;
}): Promise<void> {
  const { app, workspaceRoot } = input;
  const config = getConfig();
  if (!config.appRuntime.enabled) return;
  const template = await appTemplate(projectAt(app, workspaceRoot)).catch(() => null);
  if (!template || templatePackageManager(template) !== 'pnpm') return;
  try {
    assertNoNpmrc(await npmrcFiles(workspaceRoot));
    const manifest = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
    assertRegistryDependencies({ manifest, lockfile: await readOptional(join(workspaceRoot, 'pnpm-lock.yaml')) });

    const runtime = input.runtime
      ? await input.runtime()
      : await ensureAppRuntime({ app, workspaceRoot });
    if (runtime.status !== 'ready') {
      // 归一化必须真的在 runtime 内跑：运行时不可用就不能确认依赖一致性，本轮明确失败，
      // 不能把「没检查」当成成功（后续构建碰巧失败也不算这条验收）。
      throw new DependencyFinalizeError(
        `依赖归一化失败：App runtime 未就绪（${runtime.status}${runtime.error ? `：${runtime.error}` : ''}），本轮无法确认 package.json 与锁文件一致。`,
        'install',
      );
    }
    const timeoutMs = config.appRuntime.startTimeoutMs;
    const normalize = await runRuntimeShell({ app, command: normalizeCommand(app), timeoutMs, signal: input.signal });
    if (input.signal?.aborted) throw input.signal.reason;
    if (normalize.exitCode !== 0 || normalize.timedOut) throw installFailure('归一化锁文件', normalize);

    const normalizedLock = await readOptional(join(workspaceRoot, 'pnpm-lock.yaml'));
    if (!normalizedLock) throw new DependencyFinalizeError('依赖归一化失败：pnpm 没有生成 pnpm-lock.yaml。', 'install');
    assertRegistryDependencies({ manifest: await readFile(join(workspaceRoot, 'package.json'), 'utf8'), lockfile: normalizedLock });

    const install = await runRuntimeShell({ app, command: frozenInstallCommand(app), timeoutMs, signal: input.signal });
    if (input.signal?.aborted) throw input.signal.reason;
    if (install.exitCode !== 0 || install.timedOut) throw installFailure('安装', install);
    await recordDependenciesInstalled(app, workspaceRoot);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (error instanceof DependencyFinalizeError) throw markBuildFailure(error, { stage: error.stage, detail: error.message });
    // 来源策略与 .npmrc 算源码阶段：模型可以改清单，修复轮会带着诊断重试。
    if (error instanceof DependencySourceError) throw sourceFailure(error);
    // Docker/容器不可用不是模型能修的：按平台失败明确终止，不要伪装成源码问题。
    throw markBuildFailure(error instanceof Error ? error : new Error(String(error)), { stage: 'platform' });
  }
}
