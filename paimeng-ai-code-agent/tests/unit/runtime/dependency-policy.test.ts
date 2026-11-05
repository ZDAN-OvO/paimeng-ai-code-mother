import { describe, expect, it } from 'vitest';
import {
  assertNoPnpmHook,
  assertNoWorkspaceFile,
  assertRegistryDependencies,
} from '@/server/runtime/dependency-policy';

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
  it('接受版本范围、dist-tag 与合规 overrides', () => {
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest({
          optionalDependencies: { fsevents: '^2.3.3' },
          peerDependencies: { react: '>=18 <20' },
          overrides: { dayjs: '1.11.13', 'vite>esbuild': '~0.25.0', nested: { react: '19.1.0' } },
          pnpm: { overrides: { 'react-dom>scheduler': '0.23.2' } },
        }),
      }),
    ).not.toThrow();
    expect(() => assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: 'latest' } }) })).not.toThrow();
    expect(() =>
      assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: '1.x || >=2 <3' } }) }),
    ).not.toThrow();
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
    expect(() =>
      assertRegistryDependencies({ manifest: manifest({}, { dependencies: { dayjs: spec } }) }),
    ).toThrow(/依赖来源不被允许/);
  });

  it('拒绝非法包名与非字符串版本', () => {
    expect(() =>
      assertRegistryDependencies({ manifest: manifest({}, { dependencies: { '../escape': '1.0.0' } }) }),
    ).toThrow(/依赖来源不被允许/);
    expect(() =>
      assertRegistryDependencies({ manifest: JSON.stringify({ dependencies: { dayjs: 1 } }) }),
    ).toThrow(/依赖来源不被允许/);
    expect(() => assertRegistryDependencies({ manifest: '{not json' })).toThrow(/依赖来源不被允许/);
  });

  it('锁文件只认 registry 解析，出现 tarball/repo/https 就拒绝', () => {
    const registryLock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      dayjs:',
      "        specifier: ^1.11.0",
      '        version: 1.11.13',
      '',
    ].join('\n');
    expect(() => assertRegistryDependencies({ manifest: manifest(), lockfile: registryLock })).not.toThrow();
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest(),
        lockfile: "lockfileVersion: '9.0'\n  dayjs:\n    resolution: {tarball: https://evil.invalid/dayjs.tgz}\n",
      }),
    ).toThrow(/依赖来源不被允许/);
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest(),
        lockfile: "lockfileVersion: '9.0'\n  local:\n    resolution: {directory: ../local}\n",
      }),
    ).toThrow(/依赖来源不被允许/);
  });

  it('YAML 转义不能把 registry 以外的地址藏过检查', () => {
    const escaped = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  dayjs@1.11.13:',
      '    resolution: {"tarball": "\\u0068ttps://evil.invalid/dayjs.tgz"}',
      '',
    ].join('\n');
    expect(() => assertRegistryDependencies({ manifest: manifest(), lockfile: escaped })).toThrow(
      /依赖来源不被允许/,
    );
  });

  it('pnpm-workspace.yaml 能在清单之外改写来源，直接拒绝', () => {
    expect(() => assertNoWorkspaceFile(['pnpm-workspace.yaml'])).toThrow(/依赖来源不被允许/);
    expect(() => assertNoWorkspaceFile(['sub/pnpm-workspace.yml'])).toThrow(/依赖来源不被允许/);
    expect(() => assertNoWorkspaceFile(['package.json'])).not.toThrow();
  });

  it('pnpm hook 能改来源，直接拒绝', () => {
    expect(() => assertNoPnpmHook(['.pnpmfile.cjs'])).toThrow(/依赖来源不被允许/);
    expect(() => assertNoPnpmHook(['.pnpmfile.js'])).toThrow(/依赖来源不被允许/);
    expect(() => assertNoPnpmHook(['package.json'])).not.toThrow();
  });

  it('npm 的 package-lock.json 只接受 registry 解析；link 与本地地址拒绝', () => {
    const npmLock = (entry: Record<string, unknown>) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { dayjs: '^1.11.0' } },
          'node_modules/dayjs': { version: '1.11.13', ...entry },
        },
      });
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest(),
        lockfile: npmLock({ resolved: 'https://registry.npmjs.org/dayjs/-/dayjs-1.11.13.tgz' }),
        manager: 'npm',
      }),
    ).not.toThrow();
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest(),
        lockfile: npmLock({ resolved: 'https://evil.invalid/dayjs.tgz' }),
        manager: 'npm',
      }),
    ).toThrow(/依赖来源不被允许/);
    expect(() =>
      assertRegistryDependencies({
        manifest: manifest(),
        lockfile: npmLock({ link: true }),
        manager: 'npm',
      }),
    ).toThrow(/依赖来源不被允许/);
  });
});
