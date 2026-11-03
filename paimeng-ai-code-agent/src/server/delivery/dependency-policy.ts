import 'server-only';

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

const externalSource = /(?:^|[\s:'"(=,{])(?:https?:\/\/|git\+|git:|ssh:\/\/|file:|link:|workspace:)/i;
// 只在非 registry 解析里出现的键：tarball/repo/commit/directory。pnpm 对 registry 包只写 integrity。
const nonRegistryResolution = /(?:^|[\s{,])(?:tarball|repo|directory|commit):/;
const supportedLockfileVersion = /^lockfileVersion:\s*'?(?:9(?:\.0)?)'?\s*$/m;
const specifierLine = /^\s+specifier:\s*(.+?)\s*$/;

/** pnpm-lock.yaml：不支持完整 YAML 解析，只按行扫描会影响来源的字段。 */
export function assertLockfileSources(lockText: string) {
  if (!supportedLockfileVersion.test(lockText)) {
    throw new DependencySourceError('依赖来源不被允许：锁文件无法识别（缺少 lockfileVersion），不能确认依赖来源。');
  }
  const lines = lockText.split('\n');
  for (const line of lines) {
    if (nonRegistryResolution.test(line)) {
      throw new DependencySourceError(`依赖来源不被允许：锁文件包含 registry 以外的解析来源 ${line.trim()}。只能锁定 npm registry 上的包。`);
    }
    if (externalSource.test(line)) {
      throw new DependencySourceError(`依赖来源不被允许：锁文件包含 registry 以外的地址 ${line.trim().slice(0, 120)}。只能锁定 npm registry 上的包。`);
    }
    const specifier = specifierLine.exec(line);
    if (specifier) {
      const value = specifier[1].replace(/^['"]|['"]$/g, '');
      assertVersionSpec('锁文件 specifier', value);
    }
  }
}

/** manifest 与（可选的）锁文件一起校验；锁文件尚未生成时只校验 manifest。 */
export function assertRegistryDependencies(input: { manifest: string; lockfile?: string | null }) {
  assertManifestSources(input.manifest);
  if (input.lockfile !== undefined && input.lockfile !== null) assertLockfileSources(input.lockfile);
}

/** 工程里出现 .npmrc 一律拒绝：它能把 registry、认证与脚本行为指向 platform 之外。 */
export function assertNoNpmrc(paths: readonly string[]) {
  if (paths.some(path => path === '.npmrc' || path.endsWith('/.npmrc'))) {
    throw new DependencySourceError('工程不允许 .npmrc：依赖只能来自 npm registry，请删除这个文件。');
  }
}
