import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { apps, users } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { getConfig } from '@/server/infra/config';
import {
  appRuntimeKey,
  runtimeContainerName,
  runtimeMounts,
  runtimeRunArgs,
  runtimeStorePath,
  runtimeVirtualStore,
  RUNTIME_DEV_PORT,
} from '@/server/runtime/plan';
import {
  containerState,
  docker,
  listManagedContainers,
  removeContainer,
} from '@/server/runtime/container';
import { runInRuntime } from '@/server/runtime/commands';
import { ensureDependencies } from '@/server/runtime/dependencies';
import { stopRuntimeWriters } from '@/server/runtime/barrier';
import {
  ensureAppRuntime,
  prepareRuntimeImage,
  reconcileRuntime,
} from '@/server/runtime/supervisor';
import { readAppRuntime, saveAppRuntime } from '@/server/runtime/store';

const exec = promisify(execFile);

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
// 每轮一个运行标识：容器名与 store 目录都按它隔离，和其他 checkout 的 runtime 互不相干。
process.env.RUNTIME_RUN_ID ??= `sys-${randomUUID().slice(0, 8)}`;

/**
 * PR-02 的真实 Docker 验收：镜像身份、两个 App 的包文件共享、第二 App 增量、--init 僵尸回收。
 *
 * 这里不做生成、不写台账以外的产品状态；它证明的是 runtime 执行环境本身与 S1/S3 的决定，
 * 不替代 PR-03 的构建切换或 PR-04 的 shell 屏障。
 */

const config = getConfig();
const storeRoot = runtimeStorePath(config.runtimeRoot, config.appRuntime.runId);
/** `runtimeVirtualStore()` 返回容器内路径；宿主上的同一目录在 store 挂载源下面。 */
const virtualStoreOnHost = (app: { id: string; codeGenType: 'react_project' }) =>
  join(storeRoot, 'apps', appRuntimeKey(app), '.paimeng-virtual');
const containers: string[] = [];
const workspaces: string[] = [];
let userId: bigint;
const appIds: bigint[] = [];

type Fixture = { app: { id: string; codeGenType: 'react_project' }; root: string };
const fixtures: Fixture[] = [];

/** 探针样例：PROBE_OUTPUT 存在时把本轮实测写成 lifecycle.json，没设就什么都不写。 */
const probe: Record<string, unknown> = {
  unsupported: ['dev-server-anon: 测试工程没有 Vite dev server，只有容器本身的匿名内存'],
};
function record(key: string, value: unknown) {
  probe[key] = value;
}

async function newAppRow() {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id,
    initPrompt: '运行时 system 验收',
    codeGenType: 'react_project',
    userId,
    createTime: now(),
    updateTime: now(),
  });
  appIds.push(id);
  return id;
}

/** 一个只带 pnpm 依赖的最小工程：不需要能跑 dev server，只验证安装与共享。 */
async function newProject(id: bigint): Promise<Fixture> {
  const app = { id: String(id), codeGenType: 'react_project' as const };
  const root = join(config.runtimeRoot, 'code_output', appRuntimeKey(app));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      { name: `runtime-fixture-${id}`, private: true, dependencies: { dayjs: '1.11.13' } },
      null,
      2,
    ),
  );
  await writeFile(join(root, 'index.html'), '<!doctype html><title>runtime fixture</title>');
  workspaces.push(root);
  const fixture = { app, root };
  fixtures.push(fixture);
  return fixture;
}

async function startContainer(
  fixture: Fixture,
  image: { tag: string },
  options: { init: boolean },
) {
  const name = runtimeContainerName(fixture.app, config.appRuntime.runId);
  const { uid, gid } = await stat(fixture.root);
  const args = runtimeRunArgs({
    app: fixture.app,
    runId: config.appRuntime.runId,
    image: image.tag,
    uid,
    gid,
    mounts: runtimeMounts({ workspaceRoot: fixture.root, storeRoot }),
    registry: config.buildNpmRegistry,
    virtualStore: runtimeVirtualStore(fixture.app),
  });
  const runArgs = options.init
    ? args
    : args.filter((value, index) => !(value === '--init' && args[index - 1] === '-d'));
  await removeContainer(name);
  await docker(
    runArgs.map((value) => (value === name ? `${name}-${options.init ? 'init' : 'plain'}` : value)),
    120_000,
  );
  const actualName = `${name}-${options.init ? 'init' : 'plain'}`;
  containers.push(actualName);
  return actualName;
}

/** 递归找出某个包的真实文件（虚拟 store 里是指向 store 内容的硬链接）。 */
async function findPackageFile(
  dir: string,
  packageName: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 6) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const found = await findPackageFile(path, packageName, depth + 1);
      if (found) return found;
      continue;
    }
    if (entry.name !== 'package.json') continue;
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { name?: string };
    if (manifest.name === packageName) return path;
  }
  return null;
}

/** 实际分配的空间（块），不是 apparent size：共享包的价值在于宿主上只存一份块。 */
async function directorySize(path: string): Promise<number> {
  const { stdout } = await exec('du', ['-sB1', path]);
  return Number(stdout.split('\t')[0]);
}

async function zombieCount(container: string): Promise<number> {
  const result = await runInRuntime({
    container,
    command: [
      'sh',
      '-lc',
      "awk '/^State:/{if ($2 ~ /Z/) c++} END{print c+0}' /proc/[0-9]*/status 2>/dev/null",
    ],
    timeoutMs: 20_000,
    outputBytes: 4096,
  });
  return Number(result.output.trim() || 0);
}

async function spawnOrphans(container: string) {
  // 子进程被留成孤儿（reparent 到 PID 1），0.2 秒后退出；有 --init 时应被回收，没有则变僵尸。
  await runInRuntime({
    container,
    command: ['sh', '-lc', 'for i in $(seq 1 20); do sleep 0.2 & done; exit 0'],
    timeoutMs: 20_000,
  });
  await new Promise((done) => setTimeout(done, 1500));
}

beforeAll(async () => {
  const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}'], 10_000).catch(
    () => null,
  );
  if (!dockerVersion) throw new Error('system 用例需要可用的 Docker 守护进程');
  // bind mount 的源必须由宿主用户建好：Docker 自动创建时会是 root 所有，容器内 uid 写不进去。
  await mkdir(storeRoot, { recursive: true });
  const image = await prepareRuntimeImage();
  expect(image.tag).toContain('paimeng-app-runtime:');
  userId = await nextSnowflakeId();
  await db()
    .insert(users)
    .values({
      id: userId,
      userAccount: 'sys_runtime_' + randomUUID(),
      userPassword: 'unused',
      userRole: 'user',
      createTime: now(),
      updateTime: now(),
    });
}, 600_000);

afterAll(async () => {
  if (process.env.PROBE_OUTPUT) {
    await mkdir(process.env.PROBE_OUTPUT, { recursive: true });
    await writeFile(
      join(process.env.PROBE_OUTPUT, 'lifecycle.json'),
      JSON.stringify({ ...probe, capturedAt: new Date().toISOString() }, null, 2) + '\n',
    );
  }
  for (const container of containers) await removeContainer(container);
  for (const root of workspaces) await rm(root, { recursive: true, force: true });
  for (const appId of appIds) await db().delete(apps).where(eq(apps.id, appId));
  if (userId) await db().delete(users).where(eq(users.id, userId));
  await getPool().end();
}, 120_000);

describe('App runtime 执行环境', () => {
  it('全新一轮的 store 目录由 supervisor 自己建出来，不依赖测试先 mkdir', async () => {
    const fixture = await newProject(await newAppRow());
    const name = runtimeContainerName(fixture.app, config.appRuntime.runId);
    containers.push(name);
    // 模拟第一次运行：本轮目录不存在，createContainer 必须补出 runs/<runId>/store。
    await rm(storeRoot, { recursive: true, force: true });

    const view = await ensureAppRuntime({ app: fixture.app, workspaceRoot: fixture.root });
    expect((await stat(storeRoot)).isDirectory()).toBe(true);
    // fixture 没有 dev server，失败可以接受；失败原因必须来自 dev server，而不是目录不存在。
    expect(view.error ?? '').not.toMatch(/ENOENT/);
  }, 300_000);

  it('容器以宿主 uid 写出文件，宿主可直接删除；容器带平台标签，supervisor 重启后按标签认得它', async () => {
    const fixture = await newProject(await newAppRow());
    const image = await prepareRuntimeImage();
    const name = await startContainer(fixture, image, { init: true });

    const state = await containerState(name, RUNTIME_DEV_PORT);
    expect(state.running).toBe(true);
    // dev server 端口由 Docker 分配并只绑本机。
    expect(state.port).toBeGreaterThan(0);

    const written = await runInRuntime({
      container: name,
      command: ['sh', '-lc', 'echo ok > /work/host-visible.txt'],
      timeoutMs: 20_000,
    });
    expect(written.exitCode).toBe(0);
    const file = join(fixture.root, 'host-visible.txt');
    expect((await stat(file)).uid).toBe((await stat(fixture.root)).uid);
    await rm(file);

    const managed = await listManagedContainers(config.appRuntime.runId);
    expect(managed.map((item) => item.name)).toContain(name);

    const stopStarted = Date.now();
    await removeContainer(name);
    record('containerStopMs', Date.now() - stopStarted);
    expect(managed.find((item) => item.name === name)?.appKey).toBe(appRuntimeKey(fixture.app));
  }, 180_000);

  it('两个 App 装同一个包：包文件同 inode，第二个 App 的磁盘增量不超过首份的 20%', async () => {
    const image = await prepareRuntimeImage();
    const first = await newProject(await newAppRow());
    const nameA = await startContainer(first, image, { init: true });
    const lockOnly = (fixture: Fixture) => [
      'pnpm',
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--reporter=append-only',
      '--store-dir=/store',
      '--virtual-store-dir=' + runtimeVirtualStore(fixture.app),
    ];
    const firstStarted = Date.now();
    const generated = await runInRuntime({
      container: nameA,
      command: lockOnly(first),
      workdir: '/work',
      timeoutMs: 300_000,
    });
    expect(generated.exitCode, generated.output).toBe(0);
    const installedA = await ensureDependencies({
      app: first.app,
      workspaceRoot: first.root,
      container: nameA,
      imageIdentity: image.identity,
      timeoutMs: 300_000,
    });
    expect(installedA.installed).toBe(true);
    record('installFirstMs', Date.now() - firstStarted);

    const storeBefore = await directorySize(storeRoot);
    record('storeFirstBytes', storeBefore);
    record('workspaceBytes', await directorySize(first.root));

    const second = await newProject(await newAppRow());
    const nameB = await startContainer(second, image, { init: true });
    const secondStarted = Date.now();
    const generatedB = await runInRuntime({
      container: nameB,
      command: lockOnly(second),
      workdir: '/work',
      timeoutMs: 300_000,
    });
    expect(generatedB.exitCode, generatedB.output).toBe(0);
    const installedB = await ensureDependencies({
      app: second.app,
      workspaceRoot: second.root,
      container: nameB,
      imageIdentity: image.identity,
      timeoutMs: 300_000,
    });
    expect(installedB.installed).toBe(true);
    record('installSecondMs', Date.now() - secondStarted);

    const fileA = await findPackageFile(virtualStoreOnHost(first.app), 'dayjs');
    const fileB = await findPackageFile(virtualStoreOnHost(second.app), 'dayjs');
    expect(fileA, '第一个 App 的 dayjs 必须落在 virtual store 里').not.toBeNull();
    expect(fileB, '第二个 App 的 dayjs 必须落在 virtual store 里').not.toBeNull();
    const statA = await stat(fileA!);
    const statB = await stat(fileB!);
    // 同 inode —— 包内容在宿主上是同一份，符号链接数不能代替这个证明。
    expect(statB.ino).toBe(statA.ino);
    expect(statA.nlink).toBeGreaterThanOrEqual(2);

    // 第二份安装只追加自己的虚拟 store 条目；20% 上限是计划给出的预算。
    const storeAfter = await directorySize(storeRoot);
    const firstShare = await directorySize(join(storeRoot, 'apps', appRuntimeKey(first.app)));
    const incremental = storeAfter - storeBefore;
    record('storeIncrementalBytes', incremental);
    // 计划的上限是严格 20%，没有给小工程的兜底；用实际分配块，不用 apparent size。
    expect(incremental).toBeLessThanOrEqual(firstShare * 0.2);
  }, 600_000);

  it('--init 回收被遗留的孤儿进程；没有 --init 的控制组会累积僵尸', async () => {
    const image = await prepareRuntimeImage();
    const fixture = await newProject(await newAppRow());
    const name = (init: boolean) =>
      `${runtimeContainerName(fixture.app, config.appRuntime.runId)}-${init ? 'init' : 'plain'}`;

    // 两组都从平台真实启动参数出发，只差 --init 一个开关；末尾的占位命令换成 sleep：
    // PID 1 必须是不回收孤儿的进程，否则 busybox sh 自己会 wait 掉所有孩子，测不出 init 的作用。
    const { uid, gid } = await stat(fixture.root);
    const base = runtimeRunArgs({
      app: fixture.app,
      runId: config.appRuntime.runId,
      image: image.tag,
      uid,
      gid,
      mounts: runtimeMounts({ workspaceRoot: fixture.root, storeRoot }),
      registry: config.buildNpmRegistry,
      virtualStore: runtimeVirtualStore(fixture.app),
    });
    for (const init of [true, false]) {
      await removeContainer(name(init));
      const args = base.slice();
      args[args.indexOf('--name') + 1] = name(init);
      args.splice(args.length - 3, 3, 'sleep', '100000');
      const withoutInit = args.filter(
        (value, index) => !(value === '--init' && args[index - 1] === '-d'),
      );
      await docker(init ? args : withoutInit, 120_000);
      containers.push(name(init));
    }

    await spawnOrphans(name(true));
    await spawnOrphans(name(false));
    const withInitZombies = await zombieCount(name(true));
    const plainZombies = await zombieCount(name(false));
    record('zombiesWithInit', withInitZombies);
    record('zombiesWithoutInit', plainZombies);
    expect(withInitZombies).toBe(0);
    expect(plainZombies).toBeGreaterThan(0);
  }, 300_000);

  it('停止屏障清掉 detached、setsid、忽略 TERM 的写者，屏障后 5 秒源码不再变化', async () => {
    const fixture = await newProject(await newAppRow());
    const image = await prepareRuntimeImage();
    const name = await startContainer(fixture, image, { init: true });

    const spawned = await runInRuntime({
      container: name,
      command: [
        'sh',
        '-lc',
        [
          'for i in $(seq 1 50); do (while :; do date +%s%N >> /work/writers.log; sleep 0.05; done) & done',
          'setsid sh -c \'trap "" TERM; while :; do echo x >> /work/ignored-term.log; sleep 0.05; done\' >/dev/null 2>&1 &',
          'exit 0',
        ].join('\n'),
      ],
      timeoutMs: 30_000,
    });
    expect(spawned.exitCode, spawned.output).toBe(0);
    await new Promise((done) => setTimeout(done, 1200));

    const result = await stopRuntimeWriters({
      container: name,
      workspaceRoot: fixture.root,
      observeMs: 5_000,
    });
    record('barrier', {
      killed: result.killed,
      survivors: result.survivors,
      zombies: result.zombies,
      stable: result.stable,
    });
    expect(result.killed).toBeGreaterThan(0);
    expect(result.survivors).toBe(0);
    expect(result.zombies).toBe(0);
    expect(result.stable).toBe(true);
  }, 300_000);

  it('容器被 kill 后对账把台账标成 stopped，并清掉 exited 容器', async () => {
    const fixture = await newProject(await newAppRow());
    const image = await prepareRuntimeImage();
    const name = await startContainer(fixture, image, { init: true });
    const state = await containerState(name, RUNTIME_DEV_PORT);
    await saveAppRuntime(fixture.app, {
      containerId: state.id!,
      containerName: name,
      port: state.port ?? RUNTIME_DEV_PORT,
      imageIdentity: image.identity,
      workspaceRoot: fixture.root,
      status: 'ready',
      lockDigest: null,
      lastError: null,
    });

    await docker(['kill', name], 30_000);
    await new Promise((done) => setTimeout(done, 500));
    const outcome = await reconcileRuntime();
    record('reconcileStopped', outcome.stopped);
    expect(outcome.skipped).not.toBe(true);
    expect(outcome.stopped).toContain(fixture.app.id);
    expect((await readAppRuntime(fixture.app))?.status).toBe('stopped');
  }, 300_000);
});
