import { describe, expect, it } from 'vitest';
import { assertRegistryDependencies } from '@/server/runtime/dependency-policy';

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
});
