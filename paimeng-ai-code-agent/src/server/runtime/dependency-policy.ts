import 'server-only';
import { parse as parseYaml } from 'yaml';

/**
 * 依赖来源策略：manifest 与锁文件只接受 npm registry 上的包名与版本范围。
 *
 * 这不是网络限制——App runtime 的网络按 spec 完全放开，很多包安装期要拉自己的二进制。
 * 这里约束的是「依赖声明从哪来」：git:、file:、link:、http(s):、workspace:、npm: 别名与本地
 * 路径/压缩包都会被拒绝，避免一条清单把任意主机的代码拉进构建。`overrides` 允许，但值同样要合规。
 *
 * 纯函数：不读文件、不连数据库，方便构建路径与轮末归一化共用同一份判断。
 */

export class DependencySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencySourceError';
  }
}

/** 版本范围允许的字符：semver 运算符、数字、通配符与 dist-tag 的字母。 */
const versionRangeCharacters = /^[0-9A-Za-z.*+^~<>=| -]+$/;
const protocolPrefix = /^(?:git|git\+ssh|git\+https|git\+http|file|link|https?|workspace|npm|github|gitlab|bitbucket|ssh|portal|patch|exec):/i;
const localPathPrefix = /^(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/])/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function describeSpec(spec: string) {
  return spec.length > 80 ? `${spec.slice(0, 80)}…` : spec;
}

function assertPackageName(name: string) {
  if (name.length > 214 || name.includes('..') || !packageName.test(name)) {
    throw new DependencySourceError(`依赖来源不被允许：不支持的依赖名 ${JSON.stringify(describeSpec(name))}，只能使用 npm registry 上的包名。`);
  }
}

function assertVersionSpec(name: string, raw: unknown) {
  if (typeof raw !== 'string') {
    throw new DependencySourceError(`依赖来源不被允许：${name} 的版本必须是字符串形式的 registry 版本范围。`);
  }
  const spec = raw.trim();
  if (!spec) throw new DependencySourceError(`依赖来源不被允许：${name} 缺少版本范围。`);
  if (protocolPrefix.test(spec) || localPathPrefix.test(spec) || /\.(?:tgz|tar|tar\.gz)$/i.test(spec) || !versionRangeCharacters.test(spec)) {
    throw new DependencySourceError(
      `依赖来源不被允许：${name}@${describeSpec(spec)} 不是 npm registry 的包名与版本范围。git:、file:、link:、http(s):、workspace:、npm: 别名、本地路径与压缩包都不接受；请改成 registry 上的版本范围。`,
    );
  }
}

function assertOverrideValue(label: string, value: unknown) {
  if (typeof value === 'string') {
    assertVersionSpec(label, value);
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DependencySourceError(`依赖来源不被允许：overrides 里 ${label} 必须是版本范围或嵌套的包选择器。`);
  }
  for (const [selector, nested] of Object.entries(value as Record<string, unknown>)) {
    for (const part of selector.split('>')) assertPackageName(part.trim());
    assertOverrideValue(`${label}>${selector}`, nested);
  }
}

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** package.json 的依赖声明：名称、版本范围、overrides 都只看来源，不看具体包。 */
export function assertManifestSources(manifestText: string) {
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); }
  catch { throw new DependencySourceError('依赖来源不被允许：package.json 不是合法 JSON。'); }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new DependencySourceError('依赖来源不被允许：package.json 必须是对象。');
  }
  const record = manifest as Record<string, unknown>;
  for (const section of dependencySections) {
    const value = record[section];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new DependencySourceError(`依赖来源不被允许：${section} 必须是对象。`);
    }
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      assertPackageName(name);
      assertVersionSpec(name, spec);
    }
  }
  for (const key of ['overrides', 'resolutions'] as const) {
    const overrides = record[key];
    if (overrides === undefined) continue;
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
      throw new DependencySourceError(`依赖来源不被允许：${key} 必须是对象。`);
    }
    for (const [selector, value] of Object.entries(overrides as Record<string, unknown>)) {
      for (const part of selector.split('>')) assertPackageName(part.trim());
      assertOverrideValue(`${key}>${selector}`, value);
    }
  }
  const pnpm = record.pnpm;
  if (pnpm !== undefined) {
    if (typeof pnpm !== 'object' || pnpm === null || Array.isArray(pnpm)) {
      throw new DependencySourceError('依赖来源不被允许：pnpm 配置必须是对象。');
    }
    const overrides = (pnpm as Record<string, unknown>).overrides;
    if (overrides !== undefined) {
      if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
        throw new DependencySourceError('依赖来源不被允许：pnpm.overrides 必须是对象。');
      }
      for (const [selector, value] of Object.entries(overrides as Record<string, unknown>)) {
        for (const part of selector.split('>')) assertPackageName(part.trim());
        assertOverrideValue(`pnpm.overrides>${selector}`, value);
      }
    }
  }
}

export type LockManager = 'pnpm' | 'npm';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

function registryOrigin(registry: string): string {
  try {
    return new URL(registry).origin;
  } catch {
    throw new DependencySourceError(`依赖来源不被允许：registry 不是合法 URL（${describeSpec(registry)}）。`);
  }
}

/** 锁文件里的地址只允许来自配置的 registry；解码后的值直接比较 origin。 */
function assertRegistryUrl(value: string, origin: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DependencySourceError(`依赖来源不被允许：${label} 不是合法地址（${describeSpec(value)}）。`);
  }
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new DependencySourceError(
      `依赖来源不被允许：${label} 指向 registry 以外（${describeSpec(value)}），只能锁定 ${origin} 上的包。`,
    );
  }
}

/** 任意字符串：看起来像来源地址就按 registry 校验，本地路径与压缩包一律拒绝。 */
function assertStringSource(value: string, origin: string, label: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    assertRegistryUrl(trimmed, origin, label);
    return;
  }
  if (protocolPrefix.test(trimmed) || localPathPrefix.test(trimmed) || /\.(?:tgz|tar|tar\.gz)$/i.test(trimmed)) {
    throw new DependencySourceError(
      `依赖来源不被允许：${label} 是 registry 以外的来源（${describeSpec(trimmed)}）。`,
    );
  }
}

const resolutionKeys = new Set(['tarball', 'repo', 'directory', 'commit']);

function walkLockValue(value: unknown, origin: string, path: string) {
  if (typeof value === 'string') {
    assertStringSource(value, origin, `锁文件 ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkLockValue(item, origin, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (resolutionKeys.has(key)) {
      if (typeof nested !== 'string') {
        throw new DependencySourceError(`依赖来源不被允许：锁文件 ${path}.${key} 必须是 registry 地址。`);
      }
      assertRegistryUrl(nested, origin, `锁文件 ${path}.${key}`);
      continue;
    }
    if (key === 'specifier' && typeof nested === 'string') {
      assertVersionSpec('锁文件 specifier', nested);
      continue;
    }
    if (key === 'link' && nested === true) {
      throw new DependencySourceError(`依赖来源不被允许：锁文件 ${path} 是本地 link 依赖。`);
    }
    walkLockValue(nested, origin, `${path}.${key}`);
  }
}

/** pnpm-lock.yaml：完整解析 YAML 后再判来源，编码转义不能绕过检查。 */
export function assertPnpmLockfileSources(lockText: string, registry = DEFAULT_REGISTRY) {
  const origin = registryOrigin(registry);
  let lock: unknown;
  try {
    lock = parseYaml(lockText);
  } catch {
    throw new DependencySourceError('依赖来源不被允许：锁文件不是合法 YAML，不能确认依赖来源。');
  }
  const version = (lock as { lockfileVersion?: unknown } | null)?.lockfileVersion;
  if (String(version) !== '9' && String(version) !== '9.0') {
    throw new DependencySourceError('依赖来源不被允许：锁文件无法识别（缺少 lockfileVersion 9），不能确认依赖来源。');
  }
  walkLockValue(lock, origin, 'pnpm-lock');
}

/** package-lock.json：npm 的 v2/v3 锁，逐个包检查解析地址与 link 依赖。 */
export function assertNpmLockfileSources(lockText: string, registry = DEFAULT_REGISTRY) {
  const origin = registryOrigin(registry);
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new DependencySourceError('依赖来源不被允许：锁文件不是合法 JSON，不能确认依赖来源。');
  }
  const record = lock as { lockfileVersion?: unknown; packages?: Record<string, unknown> } | null;
  const version = Number(record?.lockfileVersion);
  if (!(version === 2 || version === 3)) {
    throw new DependencySourceError('依赖来源不被允许：锁文件无法识别（缺少 lockfileVersion 2/3），不能确认依赖来源。');
  }
  const packages = record?.packages ?? {};
  for (const [name, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (item.link === true) {
      throw new DependencySourceError(`依赖来源不被允许：锁文件 ${name || '(root)'} 是本地 link 依赖。`);
    }
    if (typeof item.resolved === 'string') {
      assertRegistryUrl(item.resolved, origin, `锁文件 ${name || '(root)'} 的 resolved`);
    }
    for (const section of dependencySections) {
      const deps = item[section];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec !== 'string') continue;
        assertPackageName(dep);
        assertVersionSpec(dep, spec);
      }
    }
  }
}

/** 按锁文件类型分派；类型由调用方按实际锁文件决定。 */
export function assertLockfileSources(
  lockText: string,
  manager: LockManager = 'pnpm',
  registry = DEFAULT_REGISTRY,
) {
  if (manager === 'npm') assertNpmLockfileSources(lockText, registry);
  else assertPnpmLockfileSources(lockText, registry);
}

/** manifest 与（可选的）锁文件一起校验；锁文件尚未生成时只校验 manifest。 */
export function assertRegistryDependencies(input: {
  manifest: string;
  lockfile?: string | null;
  manager?: LockManager;
  registry?: string;
}) {
  assertManifestSources(input.manifest);
  if (input.lockfile !== undefined && input.lockfile !== null) {
    assertLockfileSources(input.lockfile, input.manager ?? 'pnpm', input.registry ?? DEFAULT_REGISTRY);
  }
}

/** 工程里出现 .npmrc 一律拒绝：它能把 registry、认证与脚本行为指向 platform 之外。 */
export function assertNoNpmrc(paths: readonly string[]) {
  if (paths.some(path => path === '.npmrc' || path.endsWith('/.npmrc'))) {
    throw new DependencySourceError('工程不允许 .npmrc：依赖只能来自 npm registry，请删除这个文件。');
  }
}
