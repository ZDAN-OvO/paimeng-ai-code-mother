import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { getConfig } from '@/server/infra/config';
import {
  appRuntimeKey,
  runtimeContainerName,
  runtimeMounts,
  runtimeRunArgs,
  runtimeStorePath,
  runtimeVirtualStore,
} from '@/server/runtime/plan';
import { docker, removeContainer } from '@/server/runtime/container';
import { runInRuntime } from '@/server/runtime/commands';
import {
  buildProject,
  ensureDependencies,
  readInstallMarker,
  typecheckProject,
} from '@/server/runtime/dependencies';
import { prepareRuntimeImage } from '@/server/runtime/supervisor';

loadEnvFile('.env');
process.env.RUNTIME_RUN_ID ??= `sysdep-${randomUUID().slice(0, 8)}`;

/**
 * 统一依赖核心的真实 Docker 验收：安装标记按镜像与锁配对失效，类型检查与构建跑同一条执行路径。
 *
 * 安装标记是「镜像身份 + 锁指纹」的配对；只比对其中一项会让镜像或依赖升级后继续复用失效安装。
 */

const config = getConfig();
const storeRoot = runtimeStorePath(config.runtimeRoot, config.appRuntime.runId);
const app = { id: `dep-${randomUUID().slice(0, 8)}`, codeGenType: 'react_project' as const };
const root = join(config.runtimeRoot, 'code_output', appRuntimeKey(app));
let container = '';
let altContainer = '';
let altStore = '';

beforeAll(async () => {
  const version = await docker(['version', '--format', '{{.Server.Version}}'], 10_000).catch(
    () => null,
  );
  if (!version) throw new Error('system 用例需要可用的 Docker 守护进程');
  await mkdir(storeRoot, { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'runtime-dependencies-fixture',
        private: true,
        scripts: { build: 'tsc' },
        devDependencies: { typescript: '5.9.3' },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          outDir: 'dist',
        },
        include: ['src'],
      },
      null,
      2,
    ),
  );
  await writeFile(join(root, 'src', 'main.ts'), 'export const answer = (): number => 42;\n');

  const image = await prepareRuntimeImage();
  const name = runtimeContainerName(app, config.appRuntime.runId);
  const { uid, gid } = await stat(root);
  await removeContainer(name);
  await docker(
    runtimeRunArgs({
      app,
      runId: config.appRuntime.runId,
      image: image.tag,
      uid,
      gid,
      mounts: runtimeMounts({ workspaceRoot: root, storeRoot }),
      registry: config.buildNpmRegistry,
      virtualStore: runtimeVirtualStore(app),
    }),
    120_000,
  );
  container = name;
}, 600_000);

afterAll(async () => {
  if (container) await removeContainer(container);
  if (altContainer) await removeContainer(altContainer);
  if (altStore) await rm(altStore, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}, 120_000);

describe('统一依赖核心', () => {
  it('首次安装生成锁与标记，第二次按镜像+锁复用；改锁或改镜像身份都触发重装', async () => {
    const image = await prepareRuntimeImage();
    const install = () =>
      ensureDependencies({
        app,
        workspaceRoot: root,
        container,
        imageIdentity: image.identity,
        storeRoot,
        timeoutMs: 300_000,
      });

    const first = await install();
    expect(first.installed).toBe(true);
    const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    expect(lock.length).toBeGreaterThan(0);

    const marker = await readInstallMarker(root);
    expect(marker?.imageIdentity).toBe(image.identity);
    // 标记必须记录安装后生成的锁指纹，否则无锁工程每轮都会被判成失效。
    expect(marker?.lockDigest).toBe(first.pair.lockDigest);
    expect(marker?.lockDigest).not.toBeNull();

    const second = await install();
    expect(second.installed).toBe(false);

    await writeFile(join(root, 'pnpm-lock.yaml'), `${lock}# dependency source changed\n`);
    const afterLockChange = await install();
    expect(afterLockChange.installed).toBe(true);
    expect(afterLockChange.pair.lockDigest).not.toBe(marker?.lockDigest);

    const afterImageChange = await ensureDependencies({
      app,
      workspaceRoot: root,
      container,
      imageIdentity: `${image.identity}-rebuilt`,
      storeRoot,
      timeoutMs: 300_000,
    });
    expect(afterImageChange.installed).toBe(true);
    expect((await readInstallMarker(root))?.imageIdentity).toBe(`${image.identity}-rebuilt`);
  }, 600_000);

  it('换一轮空 store 时按标记重装：node_modules 里的链接重新接上，不再复用悬空安装', async () => {
    const image = await prepareRuntimeImage();
    altStore = `${storeRoot}-alt-${Date.now()}`;
    await mkdir(altStore, { recursive: true });
    altContainer = `${runtimeContainerName(app, config.appRuntime.runId)}-alt`;
    const { uid, gid } = await stat(root);
    await removeContainer(altContainer);
    const args = runtimeRunArgs({
      app,
      runId: config.appRuntime.runId,
      image: image.tag,
      uid,
      gid,
      mounts: runtimeMounts({ workspaceRoot: root, storeRoot: altStore }),
      registry: config.buildNpmRegistry,
      virtualStore: runtimeVirtualStore(app),
    });
    args[args.indexOf('--name') + 1] = altContainer;
    await docker(args, 120_000);

    const reinstalled = await ensureDependencies({
      app,
      workspaceRoot: root,
      container: altContainer,
      imageIdentity: image.identity,
      storeRoot: altStore,
      timeoutMs: 300_000,
    });
    expect(reinstalled.installed).toBe(true);
    const linked = await runInRuntime({
      container: altContainer,
      command: ['test', '-e', 'node_modules/typescript/package.json'],
      workdir: '/work',
      timeoutMs: 20_000,
    });
    expect(linked.exitCode, linked.output).toBe(0);
  }, 600_000);

  it('类型检查与构建走同一容器执行路径：合法源码通过，类型错误可辨认，构建产物落在 Workspace', async () => {
    const passed = await typecheckProject({
      container,
      packageManager: 'pnpm',
      timeoutMs: 180_000,
    });
    expect(passed.exitCode, passed.output).toBe(0);

    await writeFile(
      join(root, 'src', 'broken.ts'),
      "export const broken: number = 'not a number';\n",
    );
    const failed = await typecheckProject({
      container,
      packageManager: 'pnpm',
      timeoutMs: 180_000,
    });
    expect(failed.exitCode).not.toBe(0);
    await rm(join(root, 'src', 'broken.ts'));

    const built = await buildProject({ container, packageManager: 'pnpm', timeoutMs: 180_000 });
    expect(built.exitCode, built.output).toBe(0);
    const artifact = await readFile(join(root, 'dist', 'main.js'), 'utf8');
    expect(artifact).toContain('42');
  }, 600_000);
});
