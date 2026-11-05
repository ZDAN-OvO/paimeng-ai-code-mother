import 'server-only';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoNpmrc, assertRegistryDependencies, DependencySourceError } from './dependency-policy';
import { runInRuntime, type CommandResult } from './commands';
import { installCommand, runtimeVirtualStore, RUNTIME_WORKDIR, type RuntimeApp } from './plan';

/**
 * 统一的依赖能力：安装、类型检查、构建，以及安装标记。
 *
 * 平台安装与模型 shell 走同一份命令与同一个 virtual store，所以两个 App 的包文件在宿主上
 * 是同一批 inode；镜像身份或锁文件变化时，同一容器的旧安装按「配对」失效重装。
 */

export type PackageManager = 'npm' | 'pnpm';

const lockfiles: Record<PackageManager, string> = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' };

/** 静态模板没有依赖；工程模板用哪个包管理器由锁文件决定，和模板注册表解耦。 */
export async function detectPackageManager(root: string): Promise<PackageManager | null> {
  for (const manager of ['pnpm', 'npm'] as const) {
    try {
      const info = await stat(join(root, lockfiles[manager]));
      if (info.isFile()) return manager;
    } catch {
      // 没有这个锁文件，继续看下一个。
    }
  }
  return null;
}

/** 锁文件内容指纹；没有锁文件返回 null（安装命令会退回非 frozen 模式）。 */
export async function lockfileDigest(root: string, manager: PackageManager): Promise<string | null> {
  try {
    const content = await readFile(join(root, lockfiles[manager]));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export type DependencyPair = { imageIdentity: string; lockDigest: string | null };

/** 安装标记：镜像与锁文件都一致才复用，任何一个变了都必须重装。 */
export async function readInstallMarker(root: string): Promise<DependencyPair | null> {
  try {
    const raw = await readFile(join(root, '.paimeng-dependencies.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DependencyPair>;
    if (typeof parsed.imageIdentity !== 'string') return null;
    return { imageIdentity: parsed.imageIdentity, lockDigest: parsed.lockDigest ?? null };
  } catch {
    return null;
  }
}

export async function writeInstallMarker(root: string, pair: DependencyPair): Promise<void> {
  await writeFile(join(root, '.paimeng-dependencies.json'), JSON.stringify(pair));
}

/** 工程里出现 `.npmrc`，或清单/锁文件指向 registry 之外，一律在安装前拒绝。 */
export async function assertDependencySources(root: string): Promise<void> {
  const present = await stat(join(root, '.npmrc')).then(
    () => ['.npmrc'],
    () => [],
  );
  assertNoNpmrc(present);
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  const manager = await detectPackageManager(root);
  const lock = manager ? await readFile(join(root, lockfiles[manager]), 'utf8').catch(() => null) : null;
  assertRegistryDependencies({ manifest, lockfile: lock });
}

export type InstallResult = { installed: boolean; command: string[] };

/**
 * 在 runtime 里安装依赖。标记命中且 vite 可执行时直接复用；否则按锁文件重装。
 * 返回是否真的执行了安装，调用方负责写回台账的 lockDigest。
 */
export async function ensureDependencies(input: {
  app: RuntimeApp;
  workspaceRoot: string;
  container: string;
  imageIdentity: string;
  timeoutMs: number;
}): Promise<InstallResult & { pair: DependencyPair }> {
  const manager = await detectPackageManager(input.workspaceRoot);
  const digest = manager ? await lockfileDigest(input.workspaceRoot, manager) : null;
  const pair: DependencyPair = { imageIdentity: input.imageIdentity, lockDigest: digest };
  if (!manager) return { installed: false, command: [], pair };

  const marker = await readInstallMarker(input.workspaceRoot);
  if (marker && marker.imageIdentity === pair.imageIdentity && marker.lockDigest === pair.lockDigest) {
    // node_modules 的条目在宿主上是相对符号链接，只有容器里能确认真实可用。
    const probe = await runInRuntime({
      container: input.container,
      command: ['test', '-x', 'node_modules/.bin/vite'],
      timeoutMs: 20_000,
    });
    if (probe.exitCode === 0) return { installed: false, command: [], pair };
  }

  const command = installCommand({
    packageManager: manager,
    hasLockfile: digest !== null,
    virtualStore: runtimeVirtualStore(input.app),
  });
  const result = await runInRuntime({
    container: input.container,
    command,
    workdir: RUNTIME_WORKDIR,
    timeoutMs: input.timeoutMs,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new DependencyInstallError(manager, result);
  }
  await writeInstallMarker(input.workspaceRoot, pair);
  return { installed: true, command, pair };
}

export class DependencyInstallError extends Error {
  constructor(readonly packageManager: PackageManager, readonly result: CommandResult) {
    const reason = result.timedOut ? '安装超时' : '安装失败';
    super(`${reason}（${packageManager}）：${result.output.trim().slice(-800) || `退出码 ${result.exitCode}`}`);
    this.name = 'DependencyInstallError';
  }
}

/** 类型检查与构建共用同一条执行路径；调用方（构建核心、self-check）只决定跑哪一步。 */
export async function typecheckProject(input: {
  container: string;
  packageManager: PackageManager;
  timeoutMs: number;
}): Promise<CommandResult> {
  return runInRuntime({
    container: input.container,
    command: [input.packageManager, 'exec', 'tsc', '--noEmit'],
    workdir: RUNTIME_WORKDIR,
    timeoutMs: input.timeoutMs,
  });
}

export async function buildProject(input: {
  container: string;
  packageManager: PackageManager;
  timeoutMs: number;
}): Promise<CommandResult> {
  return runInRuntime({
    container: input.container,
    command: [input.packageManager, 'run', 'build'],
    workdir: RUNTIME_WORKDIR,
    timeoutMs: input.timeoutMs,
  });
}

export { DependencySourceError };
