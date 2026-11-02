import { describe, expect, it } from 'vitest';
import {
  appNeedsRuntime, appRuntimeKey, devServerCommand, installCommand, lockfileDigest, runtimeAppDataPath, runtimeContainerName,
  runtimeDockerfile, runtimeEnvironment, runtimeImageTag, runtimeMounts, runtimePaths, runtimePreviewBase,
  runtimeRunArgs, runtimeStorePath, runtimeVirtualStore, RUNTIME_DEV_PORT,
} from '@/server/app-runtime/plan';

const app = { id: '900000001', codeGenType: 'react_project' as const };

describe('App runtime 容器策略', () => {
  it('以 Workspace 属主的宿主 uid 运行，只挂持久 Workspace 与共享 pnpm store', () => {
    const mounts = runtimeMounts({ workspaceRoot: '/host/code_output/react_project_900000001', storeRoot: '/host/app-runtime/store' });
    expect(mounts).toEqual([
      { source: '/host/code_output/react_project_900000001', target: '/work' },
      { source: '/host/app-runtime/store', target: '/store' },
    ]);
    const virtualStore = runtimeVirtualStore(app);
    expect(virtualStore).toBe('/store/apps/react_project_900000001/.paimeng-virtual');
    expect(runtimeAppDataPath('/host', app)).toBe('/host/app-runtime/store/apps/react_project_900000001');
    const args = runtimeRunArgs({
      app, image: 'paimeng-app-runtime:abc', uid: 1234, gid: 5678, mounts,
      registry: 'https://registry.npmjs.org', virtualStore,
    });
    expect(args.slice(0, 3)).toEqual(['run', '-d', '--name']);
    expect(args).toContain(runtimeContainerName(app));
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '1234:5678']);
    // 网络按 spec 放开：不出现 --network=none；宿主端口只绑本机，由 Docker 分配。
    expect(args).not.toContain('--network=none');
    expect(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2)).toEqual(['--publish', `127.0.0.1::${RUNTIME_DEV_PORT}`]);
    const mountArgs = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []);
    expect(mountArgs).toEqual([
      'type=bind,src=/host/code_output/react_project_900000001,dst=/work',
      'type=bind,src=/host/app-runtime/store,dst=/store',
    ]);
    expect(mountArgs.join(' ')).not.toContain('docker.sock');
  });

  it('不注入平台环境变量：只有 HOME、corepack 与 npm 的 store/virtual store/registry', () => {
    const env = runtimeEnvironment({ registry: 'https://registry.npmmirror.com', virtualStore: runtimeVirtualStore(app) });
    expect(env).toEqual([
      'HOME=/tmp',
      'COREPACK_HOME=/store/corepack',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
      'COREPACK_NPM_REGISTRY=https://registry.npmmirror.com',
      'npm_config_store_dir=/store',
      // 模型自己执行的 pnpm 与平台安装必须共用同一个 virtual store，包文件才能硬链接进共享 store。
      'npm_config_virtual_store_dir=/store/apps/react_project_900000001/.paimeng-virtual',
      'npm_config_registry=https://registry.npmmirror.com',
      'CI=1',
    ]);
    for (const secret of ['DATABASE_URL', 'REDIS_URL', 'APP_ORIGIN', 'PREVIEW_ORIGIN', 'AI_API_KEY', 'MODEL_SECRET_KEY', 'DURABLE_PG_URL']) {
      expect(env.join('\n')).not.toContain(secret);
    }
  });

  it('镜像身份由基础镜像与 pnpm 版本决定，Dockerfile 固定 pnpm 与 git', () => {
    const first = runtimeImageTag('node:24-alpine', '10.18.3');
    expect(first).toBe(runtimeImageTag('node:24-alpine', '10.18.3'));
    expect(first).not.toBe(runtimeImageTag('node:24-alpine', '10.19.0'));
    const dockerfile = runtimeDockerfile('node:24-alpine', '10.18.3');
    expect(dockerfile).toContain('FROM node:24-alpine');
    expect(dockerfile).toContain('npm install -g pnpm@10.18.3');
    expect(dockerfile).toContain('git');
  });

  it('dev server 只对构建类模板存在，并把资源与 HMR 落在预览前缀下', () => {
    expect(devServerCommand({ template: { id: 'react-ts', version: '2.0.0' }, basePath: runtimePreviewBase(app) }))
      .toEqual(['node', 'node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', String(RUNTIME_DEV_PORT), '--strictPort', '--base', `/preview/${appRuntimeKey(app)}/`]);
    expect(devServerCommand({ template: null, basePath: '/preview/html_1/' })).toBeNull();
    expect(devServerCommand({ template: { id: 'html', version: '1.0.0' }, basePath: '/preview/html_1/' })).toBeNull();
  });

  it('依赖安装与锁文件指纹：pnpm 走共享 store，锁文件变化得到不同指纹', () => {
    expect(installCommand({ packageManager: 'pnpm', hasLockfile: true })).toEqual([
      'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only', '--store-dir=/store',
    ]);
    expect(installCommand({ packageManager: 'npm', hasLockfile: true })).toEqual(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(lockfileDigest('lockfileVersion: 9')).not.toBe(lockfileDigest('lockfileVersion: 9\n'));
  });

  it('只有构建类应用需要 runtime，路径与容器名按应用标识隔离', () => {
    expect(appNeedsRuntime(app)).toBe(true);
    expect(appNeedsRuntime({ id: '1', codeGenType: 'html' })).toBe(false);
    expect(runtimeContainerName(app)).toBe(`paimeng-app-runtime-${app.codeGenType}_${app.id}`);
    const paths = runtimePaths('/root', app);
    expect(paths.base).toBe(`/root/app-runtime/${app.codeGenType}_${app.id}`);
    expect(runtimeStorePath('/root')).toBe('/root/app-runtime/store');
  });
});
