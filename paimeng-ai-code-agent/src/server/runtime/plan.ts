import 'server-only';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isProjectCodeGenType, type CodeGenType } from '@/shared/contracts';

/**
 * App runtime 的纯策略层：容器名、镜像身份、挂载、启动参数、依赖安装与 dev server 命令。
 *
 * 这里只算「应该长什么样」，不执行 Docker。唯一的执行者是 `runtime/supervisor.ts`；
 * 预览代理与测试都复用同一份计算结果，避免「测试里的挂载」和「真实容器」各写一套。
 *
 * 隔离边界（父 spec「App runtime」）：
 * - 只挂自己的持久 Workspace（含 node_modules）、共享 pnpm store；不挂 Docker socket、平台目录或别的 App。
 * - 不注入任何平台环境变量；容器里只有 HOME / COREPACK_HOME / npm 的 store 与 registry。
 * - 以 Workspace 属主的宿主 uid/gid 运行，容器写出的文件宿主用户能删。
 * - 网络放开：安装期很多包要拉自己的二进制，收窄出网点只会产生难诊断的失败。
 */

/** 容器内工作目录：Workspace 的 bind mount 目标。 */
export const RUNTIME_WORKDIR = '/work';
/** 每个 App 独立的 node_modules；跨轮次保留，包内容通过硬链接共享同一个 store。 */
export const RUNTIME_NODE_MODULES = '/work/node_modules';
/** 共享的 pnpm 内容寻址 store（单独挂载）。 */
export const RUNTIME_STORE = '/store';
/**
 * App 的 pnpm virtual store：node_modules 里的包符号链接指向它，包文件在这里硬链接共享 store。
 *
 * 它必须在 store 挂载内：跨 bind mount 的 link() 会 EXDEV，pnpm 只能复制；node_modules 仍留在
 * Workspace 里（真实目录，条目是指向 virtual store 的相对符号链接），所以每个 App 的依赖树独立，
 * 而包内容在宿主上是同一批 inode。
 */
export function runtimeVirtualStore(app: RuntimeApp) {
  return `${RUNTIME_STORE}/apps/${appRuntimeKey(app)}/.paimeng-virtual`;
}

/** dev server 在容器内的固定端口；宿主端口由 Docker 随机分配并记录。 */
export const RUNTIME_DEV_PORT = 5173;
/**
 * 容器的主进程（保活）。停止屏障保留 PID 1 的最小 pid 子进程和它的子进程；
 * 把它杀掉等于结束容器，`docker exec` 会一起被终止。不写容器内可篡改的 pid 文件，
 * pid 顺序由内核分配，App 代码无法让自己排到更前。
 */
export const RUNTIME_KEEPALIVE = 'while :; do sleep 3600; done';
/** 容器名前缀；supervisor 对账与测试都按它识别「本平台的运行时容器」。 */
export const RUNTIME_CONTAINER_PREFIX = 'paimeng-app-runtime-';
/** 平台在容器里跑 dev server 的日志文件；`.paimeng-` 前缀让它不进版本、文件工具也读不到。 */
export const RUNTIME_DEV_LOG = '.paimeng-dev.log';

export type RuntimeApp = { id: string; codeGenType: CodeGenType };

export type RuntimeMount = { source: string; target: string };

/** `<codeGenType>_<appId>`：与预览路由、Workspace 目录同一套标识。 */
export function appRuntimeKey(app: RuntimeApp) {
  return `${app.codeGenType}_${app.id}`;
}

/**
 * 容器名带上运行标识：同一台机器上并行跑两个 checkout 时，同名 App 不会互相抢容器。
 * 运行标识只由本轮的 launcher 或环境给出，不由 App 内容派生。
 */
export function runtimeContainerName(app: RuntimeApp, runId: string) {
  return `${RUNTIME_CONTAINER_PREFIX}${runId}-${appRuntimeKey(app)}`;
}

/** 台账里的容器名是否属于本轮：对账与容量只处理本轮的行，不碰别的 checkout。 */
export function runtimeBelongsToRun(containerName: string, runId: string) {
  return containerName.startsWith(`${RUNTIME_CONTAINER_PREFIX}${runId}-`);
}

/** 按运行标识过滤容器；对账与清理都只碰本轮自己的容器。 */
export const RUNTIME_RUN_LABEL = 'paimeng.run';
export const RUNTIME_MANAGED_LABEL = 'paimeng.managed-by';
export const RUNTIME_APP_LABEL = 'paimeng.app-runtime';

/** 预览路由里的 dev server 基路径；Vite 用它生成资源 URL 和 HMR websocket 路径。 */
export function runtimePreviewBase(app: RuntimeApp) {
  return `/preview/${appRuntimeKey(app)}/`;
}

/** 只有构建类应用有 dev server；轻量静态页继续走静态产物。 */
export function appNeedsRuntime(app: RuntimeApp) {
  return isProjectCodeGenType(app.codeGenType);
}

export function runtimePaths(runtimeRoot: string, app: RuntimeApp) {
  const base = join(runtimeRoot, 'app-runtime', appRuntimeKey(app));
  return { base };
}

/**
 * 本轮共享的 pnpm store：同一轮的两个 App 在宿主上共享包内容，不同运行轮次各自一份，
 * 一轮的清理或异常不会影响另一轮。store 与 Workspace 必须在同一文件系统上才能硬链接。
 */
export function runtimeStorePath(runtimeRoot: string, runId: string) {
  return join(runtimeRoot, 'app-runtime', 'runs', runId, 'store');
}

/** 运行时镜像标签由「基础镜像 + pnpm 版本」决定：同一组合永远得到同一身份。 */
export function runtimeImageTag(image: string, pnpmVersion: string) {
  const digest = createHash('sha256').update(`${image}\npnpm@${pnpmVersion}`).digest('hex').slice(0, 12);
  return `paimeng-app-runtime:${digest}`;
}

/**
 * 运行时镜像的 Dockerfile 在仓库里，基础镜像与 pnpm 版本作为构建参数传入。
 * 镜像身份只由这两项决定，所以同一组合永远命中同一个标签。
 */
export const RUNTIME_DOCKERFILE = 'docker/app-runtime/Dockerfile';
export const RUNTIME_DOCKER_CONTEXT = 'docker/app-runtime';

export function runtimeBuildArgs(input: { image: string; pnpmVersion: string }): string[] {
  return ['--build-arg', `BASE_IMAGE=${input.image}`, '--build-arg', `PNPM_VERSION=${input.pnpmVersion}`];
}

export function runtimeMounts(input: { workspaceRoot: string; storeRoot: string }): RuntimeMount[] {
  return [
    { source: input.workspaceRoot, target: RUNTIME_WORKDIR },
    { source: input.storeRoot, target: RUNTIME_STORE },
  ];
}

/**
 * 容器环境变量白名单。没有 `--env` 的变量不会进容器；这里也只放运行期必需项，
 * 平台密钥、数据库地址、预览来源等一律不出现。
 */
export function runtimeEnvironment(input: { registry: string; virtualStore: string }): string[] {
  return [
    'HOME=/tmp',
    // corepack 下载的包管理器落在共享 store 里，容器重建后不用重新下载。
    'COREPACK_HOME=/store/corepack',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'COREPACK_NPM_REGISTRY=' + input.registry,
    'npm_config_store_dir=' + RUNTIME_STORE,
    // 模型自己执行的 pnpm 与平台安装必须落在同一个 virtual store，否则 hardlink 只在其中一次生效。
    'npm_config_virtual_store_dir=' + input.virtualStore,
    'npm_config_registry=' + input.registry,
    // 不读 HOME 下的用户配置：容器里 HOME 可写，.npmrc 能改写 registry 或 scope。
    'npm_config_userconfig=/dev/null',
    'NPM_CONFIG_USERCONFIG=/dev/null',
    'CI=1',
  ];
}

/** `docker run -d ...` 的完整参数；`--publish 127.0.0.1::5173` 让 Docker 分配宿主端口并只绑本机。 */
export type RuntimeRunInput = {
  app: RuntimeApp;
  /** 本轮运行标识；容器名与标签都带上它，另一轮对账不会碰到这台容器。 */
  runId: string;
  image: string;
  uid: number;
  gid: number;
  mounts: readonly RuntimeMount[];
  registry: string;
  virtualStore: string;
};

export function runtimeRunArgs(input: RuntimeRunInput): string[] {
  return [
    'run', '-d',
    // 容器里被杀掉的进程需要一个 1 号进程回收，否则每轮收束都会累积僵尸。
    '--init',
    '--name', runtimeContainerName(input.app, input.runId),
    '--label', `${RUNTIME_MANAGED_LABEL}=paimeng-platform`,
    '--label', `${RUNTIME_APP_LABEL}=${appRuntimeKey(input.app)}`,
    '--label', `${RUNTIME_RUN_LABEL}=${input.runId}`,
    '--user', `${input.uid}:${input.gid}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
    '--memory=1g', '--memory-swap=1g', '--cpus=1',
    ...input.mounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target}`]),
    '--publish', `127.0.0.1::${RUNTIME_DEV_PORT}`,
    ...runtimeEnvironment({ registry: input.registry, virtualStore: input.virtualStore }).flatMap(value => ['--env', value]),
    '--workdir', RUNTIME_WORKDIR,
    input.image,
    'sh', '-lc', RUNTIME_KEEPALIVE,
  ];
}

/** 依赖安装命令：pnpm 用模板锁文件与共享 store，npm 模板走 `npm ci`。 */
export function installCommand(input: { packageManager: 'npm' | 'pnpm'; hasLockfile: boolean; virtualStore: string }): string[] {
  if (input.packageManager === 'pnpm') {
    // 镜像里装了固定版本的 pnpm；直接用它，避免 corepack 每次再下载一份。
    return ['pnpm', 'install', input.hasLockfile ? '--frozen-lockfile' : '--no-frozen-lockfile', '--ignore-scripts', '--reporter=append-only', '--store-dir=' + RUNTIME_STORE, '--virtual-store-dir=' + input.virtualStore];
  }
  return ['npm', input.hasLockfile ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
}

/**
 * dev server 命令。只有 Vite 模板有；静态模板返回 null（不建 runtime）。
 * `--base` 让资源与 HMR websocket 都落在预览代理的同一个前缀下，代理不需要改写 HTML。
 */
export function devServerCommand(input: { basePath: string; port?: number }): string[] {
  return [
    'node', 'node_modules/vite/bin/vite.js',
    '--host', '0.0.0.0', '--port', String(input.port ?? RUNTIME_DEV_PORT), '--strictPort',
    '--base', input.basePath,
  ];
}

/** 锁文件指纹：镜像身份或它变化时，supervisor 在提供实时 Preview 前重新安装依赖。 */
export function lockfileDigest(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}
