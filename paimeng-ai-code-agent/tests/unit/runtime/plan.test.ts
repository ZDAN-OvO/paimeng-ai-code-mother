import { describe, expect, it } from 'vitest';
import {
  appNeedsRuntime,
  appRuntimeKey,
  devServerCommand,
  installCommand,
  runtimeBuildArgs,
  runtimeContainerName,
  runtimeEnvironment,
  runtimeImageTag,
  runtimeMounts,
  runtimePreviewBase,
  runtimeRunArgs,
  runtimeVirtualStore,
} from '@/server/runtime/plan';

const app = { id: '1234567890', codeGenType: 'react_project' as const };

describe('运行时容器定义', () => {
  it('一个 App 一套标识：容器名、预览基路径与 virtual store 都由 <类型>_<id> 派生', () => {
    expect(appRuntimeKey(app)).toBe('react_project_1234567890');
    expect(runtimeContainerName(app, 'run1')).toBe('paimeng-app-runtime-run1-react_project_1234567890');
    expect(runtimePreviewBase(app)).toBe('/preview/react_project_1234567890/');
    expect(runtimeVirtualStore(app)).toBe('/store/apps/react_project_1234567890/.paimeng-virtual');
  });

  it('只有构建类应用需要 runtime；静态模板继续走静态产物', () => {
    expect(appNeedsRuntime(app)).toBe(true);
    expect(appNeedsRuntime({ id: '1', codeGenType: 'html' })).toBe(false);
  });

  it('两个挂载：App 自己的 Workspace 与共享 store；virtual store 落在 store 挂载内', () => {
    const mounts = runtimeMounts({ workspaceRoot: '/runtime/code_output/react_project_1', storeRoot: '/runtime/app-runtime/store' });
    expect(mounts).toEqual([
      { source: '/runtime/code_output/react_project_1', target: '/work' },
      { source: '/runtime/app-runtime/store', target: '/store' },
    ]);
    expect(runtimeVirtualStore(app).startsWith('/store/')).toBe(true);
  });

  it('容器以宿主 uid/gid 运行、带 --init，端口只绑本机', () => {
    const args = runtimeRunArgs({
      app,
      runId: 'run1',
      image: 'paimeng-app-runtime:abc',
      uid: 1000,
      gid: 1000,
      mounts: runtimeMounts({ workspaceRoot: '/work-src', storeRoot: '/store-src' }),
      registry: 'https://registry.npmjs.org',
      virtualStore: '/store/apps/react_project_1234567890/.paimeng-virtual',
    });
    expect(args.slice(0, 3)).toEqual(['run', '-d', '--init']);
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
    expect(args[args.indexOf('--publish') + 1]).toBe('127.0.0.1::5173');
    // bind mount 只出现 Workspace 与 store 两个来源。
    const sources = args.flatMap((value, index) => (value === '--mount' ? [args[index + 1]] : []));
    expect(sources).toHaveLength(2);
    expect(sources.join(' ')).toContain('src=/work-src');
    expect(sources.join(' ')).toContain('src=/store-src');
  });

  it('环境变量是白名单：没有平台密钥、数据库地址或预览来源', () => {
    const environment = runtimeEnvironment({ registry: 'https://registry.npmjs.org', virtualStore: '/store/apps/x/.paimeng-virtual' });
    expect(environment).toContain('HOME=/tmp');
    expect(environment).toContain('npm_config_virtual_store_dir=/store/apps/x/.paimeng-virtual');
    expect(environment.some((value) => /KEY|SECRET|DATABASE|REDIS|TOKEN/i.test(value))).toBe(false);
  });

  it('镜像身份由基础镜像与 pnpm 版本决定，二者任一变化都换标签', () => {
    const base = runtimeImageTag('node:24-alpine', '10.18.3');
    expect(runtimeImageTag('node:24-alpine', '10.18.3')).toBe(base);
    expect(runtimeImageTag('node:24-alpine', '10.19.0')).not.toBe(base);
    expect(runtimeImageTag('node:24-bookworm-slim', '10.18.3')).not.toBe(base);
    expect(runtimeBuildArgs({ image: 'node:24-alpine', pnpmVersion: '10.18.3' })).toEqual([
      '--build-arg',
      'BASE_IMAGE=node:24-alpine',
      '--build-arg',
      'PNPM_VERSION=10.18.3',
    ]);
  });

  it('安装命令把 store 与 virtual store 都显式指到共享挂载', () => {
    const command = installCommand({
      packageManager: 'pnpm',
      hasLockfile: true,
      virtualStore: '/store/apps/x/.paimeng-virtual',
    });
    expect(command).toContain('--store-dir=/store');
    expect(command).toContain('--virtual-store-dir=/store/apps/x/.paimeng-virtual');
    expect(command).toContain('--frozen-lockfile');
    // 新工程还没有锁时安装要能生成锁，不能继续用冻结模式把安装挡死。
    expect(
      installCommand({ packageManager: 'pnpm', hasLockfile: false, virtualStore: '/store/x' }),
    ).toContain('--no-frozen-lockfile');
    expect(installCommand({ packageManager: 'npm', hasLockfile: true, virtualStore: '' })).toEqual([
      'npm',
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });

  it('dev server 只给 --base，不写死 HMR 端口（让 websocket 回退到代理端口）', () => {
    const command = devServerCommand({ basePath: '/preview/react_project_1/' });
    expect(command).toContain('--base');
    expect(command[command.indexOf('--base') + 1]).toBe('/preview/react_project_1/');
    expect(command.join(' ')).not.toMatch(/hmr/i);
  });
});
