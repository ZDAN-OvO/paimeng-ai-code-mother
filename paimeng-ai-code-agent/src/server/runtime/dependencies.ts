import 'server-only';
import { createHash } from 'node:crypto';
import { lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertNoNpmrc,
  assertNoPnpmHook,
  assertNoWorkspaceFile,
  assertRegistryDependencies,
  DependencySourceError,
} from './dependency-policy';
import { getConfig } from '../infra/config';
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

/**
 * 静态模板没有依赖；工程模板用哪个包管理器由锁文件决定，和模板注册表解耦。
 * 还没有锁的新工程按 pnpm 装（镜像里固定了版本），安装本身会生成锁文件。
 */
export async function detectPackageManager(root: string): Promise<PackageManager | null> {
  for (const manager of ['pnpm', 'npm'] as const) {
    try {
      const info = await stat(join(root, lockfiles[manager]));
      if (info.isFile()) return manager;
    } catch {
      // 没有这个锁文件，继续看下一个。
    }
  }
  try {
    if ((await stat(join(root, 'package.json'))).isFile()) return 'pnpm';
  } catch {
    // 没有清单：静态工程，不需要安装。
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

/**
 * 安装标记：镜像、锁文件与共享 store 三者都一致才复用。
 * store 也必须进标记：换一轮 run 后 store 是空的，旧 node_modules 里的链接会全部悬空。
 */
export type DependencyPair = {
  imageIdentity: string;
  lockDigest: string | null;
  storeRoot: string;
};

const markerName = '.paimeng-dependencies.json';

export async function readInstallMarker(root: string): Promise<DependencyPair | null> {
  const path = join(root, markerName);
  try {
    const info = await lstat(path);
    // 软链接不是平台写的标记：拒绝跟随，避免本轮安装把 Workspace 外的文件当成标记。
    if (!info.isFile()) return null;
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DependencyPair>;
    if (typeof parsed.imageIdentity !== 'string' || typeof parsed.storeRoot !== 'string') return null;
    return {
      imageIdentity: parsed.imageIdentity,
      lockDigest: parsed.lockDigest ?? null,
      storeRoot: parsed.storeRoot,
    };
  } catch {
    return null;
  }
}

export async function writeInstallMarker(root: string, pair: DependencyPair): Promise<void> {
  const path = join(root, markerName);
  const existing = await lstat(path).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new DependencySourceError('依赖来源不被允许：Workspace 里的安装标记不是普通文件，拒绝写入');
  }
  // 先写临时文件再 rename：原子替换，且不会跟随 Workspace 里预置的软链接写到目录外。
  const temp = join(root, `${markerName}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(pair), { flag: 'wx' });
  await rename(temp, path);
}

/** 工程里出现 `.npmrc` / `pnpm-workspace.yaml`，或清单/锁文件指向 registry 之外，一律在安装前拒绝。 */
export async function assertDependencySources(root: string): Promise<void> {
  const present = await stat(join(root, '.npmrc')).then(
    () => ['.npmrc'],
    () => [],
  );
  assertNoNpmrc(present);
  // pnpm 的 hook 能在来源检查之后改写依赖：.pnpmfile.cjs 的 readPackage 可以把 registry 声明换成本地路径。
  const hooks: string[] = [];
  for (const hook of ['.pnpmfile.cjs', '.pnpmfile.mjs', '.pnpmfile.js']) {
    if (
      await stat(join(root, hook)).then(
        () => true,
        () => false,
      )
    ) {
      hooks.push(hook);
    }
  }
  assertNoPnpmHook(hooks);
  const workspaceFiles: string[] = [];
  for (const workspaceFile of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    if (
      await stat(join(root, workspaceFile)).then(
        () => true,
        () => false,
      )
    ) {
      workspaceFiles.push(workspaceFile);
    }
  }
  assertNoWorkspaceFile(workspaceFiles);
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  const manager = (await detectPackageManager(root)) ?? 'pnpm';
  const lock = await readFile(join(root, lockfiles[manager]), 'utf8').catch(() => null);
  assertRegistryDependencies({
    manifest,
    lockfile: lock,
    manager,
    registry: getConfig().buildNpmRegistry,
  });
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
  storeRoot: string;
  timeoutMs: number;
}): Promise<InstallResult & { pair: DependencyPair }> {
  const manager = await detectPackageManager(input.workspaceRoot);
  const digest = manager ? await lockfileDigest(input.workspaceRoot, manager) : null;
  const pair: DependencyPair = {
    imageIdentity: input.imageIdentity,
    lockDigest: digest,
    storeRoot: input.storeRoot,
  };
  if (!manager) return { installed: false, command: [], pair };

  const marker = await readInstallMarker(input.workspaceRoot);
  if (marker && marker.storeRoot !== pair.storeRoot) {
    // 换了一轮 store：旧的 node_modules 条目都指向已经不存在的 virtual store，先清掉再装。
    await rm(join(input.workspaceRoot, 'node_modules'), { recursive: true, force: true });
  }
  if (
    marker &&
    marker.imageIdentity === pair.imageIdentity &&
    marker.lockDigest === pair.lockDigest &&
    marker.storeRoot === pair.storeRoot
  ) {
    // node_modules 的条目在宿主上是相对符号链接，只有容器里能确认真实存在；
    // 包里还必须留着包管理器自己的布局文件，否则只是同名空目录。
    const probe = await runInRuntime({
      container: input.container,
      command: [
        'sh',
        '-lc',
        'test -d node_modules && { test -e node_modules/.modules.yaml || test -e node_modules/.package-lock.json; }',
      ],
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
  // 没有锁文件时安装会新生成一份：标记必须记下生成后的指纹，否则下一次调用永远判定为失效。
  const installedPair: DependencyPair = {
    ...pair,
    lockDigest: await lockfileDigest(input.workspaceRoot, manager),
  };
  await writeInstallMarker(input.workspaceRoot, installedPair);
  return { installed: true, command, pair: installedPair };
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
