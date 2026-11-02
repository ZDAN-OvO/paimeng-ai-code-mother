import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRegistryDependencies } from '@/server/delivery/dependency-policy';

const templateRoot = join(process.cwd(), 'templates', 'react-ts', '2.0.0');
const templateManifest = () => readFile(join(templateRoot, 'package.json'), 'utf8');
const templateLock = () => readFile(join(templateRoot, 'pnpm-lock.yaml'), 'utf8');

function manifest(extra: Record<string, unknown> = {}, sections: Record<string, Record<string, string>> = {}) {
  return JSON.stringify({
    name: 'generated-app',
    private: true,
    dependencies: { dayjs: '^1.11.0', ...sections.dependencies },
    devDependencies: { ...sections.devDependencies },
    ...extra,
  });
}

describe('依赖来源策略：package.json 只接受 registry 包名与版本范围', () => {
  it('接受模板清单、版本范围、dist-tag 与合规 overrides', async () => {
    const manifestText = await templateManifest();
    expect(() => assertRegistryDependencies({ manifest: manifestText })).not.toThrow();
    expect(() => assertRegistryDependencies({
      manifest: manifest({
        optionalDependencies: { fsevents: '^2.3.3' },
        peerDependencies: { react: '>=18 <20' },
        overrides: { dayjs: '1.11.13', 'vite>esbuild': '~0.25.0', nested: { react: '19.1.0' } },
        pnpm: { overrides: { 'react-dom>scheduler': '0.23.2' } },
      }),
    })).not.toThrow();
    expect(() => assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: 'latest' } }) })).not.toThrow();
    expect(() => assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: '1.x || >=2 <3' } }) })).not.toThrow();
  });

  it.each([
    ['git:', 'git+https://github.com/user/repo.git'],
    ['git 简写', 'github:user/repo'],
    ['file:', 'file:../local-package'],
    ['link:', 'link:../shared'],
    ['https:', 'https://evil.invalid/package.tgz'],
    ['http:', 'http://evil.invalid/package.tgz'],
    ['workspace:', 'workspace:*'],
    ['npm 别名', 'npm:other-package@1.0.0'],
    ['相对路径', './local-package'],
    ['绝对路径', '/opt/local-package'],
    ['压缩包', 'package.tgz'],
  ])('拒绝 %s 依赖声明', (_label, spec) => {
    expect(() => assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: spec } }) }))
      .toThrow(/依赖来源不被允许/);
  });

  it('拒绝不合规的 overrides 与依赖名', () => {
    expect(() => assertRegistryDependencies({ manifest: manifest({ overrides: { dayjs: 'git+https://github.com/user/repo.git' } }) }))
      .toThrow(/依赖来源不被允许/);
    expect(() => assertRegistryDependencies({ manifest: manifest({ pnpm: { overrides: { dayjs: 'file:../x' } } }) }))
      .toThrow(/依赖来源不被允许/);
    expect(() => assertRegistryDependencies({ manifest: manifest({}, { dependencies: { '../escape': '1.0.0' } }) }))
      .toThrow(/依赖来源不被允许/);
  });
});

describe('依赖来源策略：pnpm-lock.yaml 不指向 registry 以外的来源', () => {
  it('接受模板锁文件与追加了 registry 包的锁文件', async () => {
    const lock = await templateLock();
    const manifestText = await templateManifest();
    expect(() => assertRegistryDependencies({ manifest: manifestText, lockfile: lock })).not.toThrow();
    const extended = lock.replace("  .:\n    dependencies:\n", "  .:\n    dependencies:\n      dayjs:\n        specifier: ^1.11.0\n        version: 1.11.13\n");
    expect(extended).not.toBe(lock);
    expect(() => assertRegistryDependencies({ manifest: manifest(), lockfile: extended })).not.toThrow();
  });

  it.each([
    ['tarball', "snapshots:\n\n  'pkg@1.0.0':\n    resolution: {tarball: https://codeload.github.com/user/repo/tar.gz/abc}\n"],
    ['git repo', "snapshots:\n\n  'pkg@1.0.0':\n    resolution: {repo: github.com/user/repo, commit: abcdef}\n"],
    ['git+ssh', "snapshots:\n\n  'pkg@1.0.0':\n    resolution: {integrity: sha512-x, type: git, url: git+ssh://git@github.com/user/repo.git}\n"],
    ['workspace 协议', "importers:\n  .:\n    dependencies:\n      pkg:\n        specifier: workspace:*\n        version: link:../pkg\n"],
    ['file 协议', "importers:\n  .:\n    dependencies:\n      pkg:\n        specifier: file:../pkg\n        version: 'file:../pkg'\n"],
  ])('拒绝锁文件里的 %s 来源', (_label, fragment) => {
    const lock = `lockfileVersion: '9.0'\n\n${fragment}`;
    expect(() => assertRegistryDependencies({ manifest: manifest(), lockfile: lock })).toThrow(/依赖来源不被允许/);
  });

  it('缺少 lockfileVersion 的锁文件不能通过来源校验', () => {
    expect(() => assertRegistryDependencies({ manifest: manifest(), lockfile: 'lockfileVersion: 0\n' }))
      .toThrow(/锁文件无法识别/);
  });
});

describe('依赖来源策略：.npmrc 不允许出现在工程里', () => {
  it('平台直接拒绝而不是忽略', async () => {
    const { assertNoNpmrc } = await import('@/server/delivery/dependency-policy');
    expect(() => assertNoNpmrc(['package.json', 'src/main.tsx'])).not.toThrow();
    expect(() => assertNoNpmrc(['package.json', '.npmrc'])).toThrow(/不允许 \.npmrc/);
  });
});
