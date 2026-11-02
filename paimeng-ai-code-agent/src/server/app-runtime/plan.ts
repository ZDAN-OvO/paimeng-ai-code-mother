import 'server-only';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isProjectCodeGenType, type CodeGenType } from '@/shared/contracts';
import type { TemplateIdentity } from '@/shared/templates';

/**
 * App runtime 的纯策略层：容器名、镜像身份、挂载、启动参数、依赖安装与 dev server 命令。
 *
 * 这里只算「应该长什么样」，不执行 Docker。唯一的执行者是 `runtime/supervisor.ts`；
 * 预览代理与测试都复用同一份计算结果，避免「测试里的挂载」和「真实容器」各写一套。
 *
 * 隔离边界（父 spec「App runtime」）：
 * - 只挂自己的 Workspace、自己的 node_modules、共享 pnpm store；不挂 Docker socket、平台目录或别的 App。
 * - 不注入任何平台环境变量；容器里只有 HOME / COREPACK_HOME / npm 的 store 与 registry。
 * - 以 Workspace 属主的宿主 uid/gid 运行，容器写出的文件宿主用户能删。
 * - 网络放开：安装期很多包要拉自己的二进制，收窄出网点只会产生难诊断的失败。
 */

/** 容器内工作目录：Workspace 的 bind mount 目标。 */
export const RUNTIME_WORKDIR = '/work';
/** 每个 App 独立的 node_modules；跨轮次保留，通过硬链接共享 pnpm store 的内容。 */
export const RUNTIME_NODE_MODULES = '/work/node_modules';
/** 共享的 pnpm 内容寻址 store。 */
export const RUNTIME_STORE = '/store';
/** dev server 在容器内的固定端口；宿主端口由 Docker 随机分配并记录。 */
export const RUNTIME_DEV_PORT = 5173;
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

export function runtimeContainerName(app: RuntimeApp) {
  return RUNTIME_CONTAINER_PREFIX + appRuntimeKey(app);
}

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
  return { base, nodeModules: join(base, 'node_modules') };
}

/** 全机共享的 pnpm store：与每个 App 的 node_modules 在同一个文件系统上才能硬链接。 */
export function runtimeStorePath(runtimeRoot: string) {
  return join(runtimeRoot, 'app-runtime', 'store');
}

/** 运行时镜像标签由「基础镜像 + pnpm 版本」决定：同一组合永远得到同一身份。 */
export function runtimeImageTag(image: string, pnpmVersion: string) {
  const digest = createHash('sha256').update(`${image}\npnpm@${pnpmVersion}`).digest('hex').slice(0, 12);
  return `paimeng-app-runtime:${digest}`;
}

/** 基础镜像之上固定 pnpm 与 git；两者都是 spec 约定的运行时能力，不能让 App 自己装。 */
export function runtimeDockerfile(image: string, pnpmVersion: string) {
  return [
    `FROM ${image}`,
    // 基础镜像既可能是 alpine 也可能是 debian 系；按可用包管理器装 git。
    'RUN if command -v apk >/dev/null 2>&1; then apk add --no-cache git; \\',
    '    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*; \\',
    '    else echo "unsupported base image: no apk or apt-get" >&2; exit 1; fi',
    `RUN npm install -g pnpm@${pnpmVersion} && pnpm --version && git --version`,
  ].join('\n') + '\n';
}

export function runtimeMounts(input: { workspaceRoot: string; nodeModulesRoot: string; storeRoot: string }): RuntimeMount[] {
  return [
    { source: input.workspaceRoot, target: RUNTIME_WORKDIR },
    { source: input.nodeModulesRoot, target: RUNTIME_NODE_MODULES },
    { source: input.storeRoot, target: RUNTIME_STORE },
  ];
}

/**
 * 容器环境变量白名单。没有 `--env` 的变量不会进容器；这里也只放运行期必需项，
 * 平台密钥、数据库地址、预览来源等一律不出现。
 */
export function runtimeEnvironment(registry: string): string[] {
  return [
    'HOME=/tmp',
    // corepack 下载的包管理器落在共享 store 里，容器重建后不用重新下载。
    'COREPACK_HOME=/store/corepack',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'COREPACK_NPM_REGISTRY=' + registry,
    'npm_config_store_dir=/store',
    'npm_config_registry=' + registry,
    'CI=1',
  ];
}

export type RuntimeRunInput = {
  app: RuntimeApp;
  image: string;
  uid: number;
  gid: number;
  mounts: readonly RuntimeMount[];
  registry: string;
};

/** `docker run -d ...` 的完整参数；`--publish 127.0.0.1::5173` 让 Docker 分配宿主端口并只绑本机。 */
export function runtimeRunArgs(input: RuntimeRunInput): string[] {
  return [
    'run', '-d',
    '--name', runtimeContainerName(input.app),
    '--label', `paimeng.managed-by=paimeng-platform`,
    '--label', `paimeng.app-runtime=${appRuntimeKey(input.app)}`,
    '--user', `${input.uid}:${input.gid}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
    '--memory=1g', '--memory-swap=1g', '--cpus=1',
    ...input.mounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target}`]),
    '--publish', `127.0.0.1::${RUNTIME_DEV_PORT}`,
    ...runtimeEnvironment(input.registry).flatMap(value => ['--env', value]),
    '--workdir', RUNTIME_WORKDIR,
    input.image,
    'sh', '-lc', 'while :; do sleep 3600; done',
  ];
}

/** 依赖安装命令：pnpm 用模板锁文件与共享 store，npm 模板走 `npm ci`。 */
export function installCommand(input: { packageManager: 'npm' | 'pnpm'; hasLockfile: boolean }): string[] {
  if (input.packageManager === 'pnpm') {
    // 镜像里装了固定版本的 pnpm；直接用它，避免 corepack 每次再下载一份。
    return ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only', '--store-dir=' + RUNTIME_STORE];
  }
  return ['npm', input.hasLockfile ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
}

/**
 * dev server 命令。只有 Vite 模板有；静态模板返回 null（不建 runtime）。
 * `--base` 让资源与 HMR websocket 都落在预览代理的同一个前缀下，代理不需要改写 HTML。
 */
export function devServerCommand(input: { template: TemplateIdentity | null; basePath: string; port?: number }): string[] | null {
  if (!input.template) return null;
  if (!['react-ts', 'vue-ts'].includes(input.template.id)) return null;
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
