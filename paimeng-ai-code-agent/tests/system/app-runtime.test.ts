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
import { prepareRuntimeImage } from '@/server/runtime/supervisor';

const exec = promisify(execFile);

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * PR-02 的真实 Docker 验收：镜像身份、两个 App 的包文件共享、第二 App 增量、--init 僵尸回收。
 *
 * 这里不做生成、不写台账以外的产品状态；它证明的是 runtime 执行环境本身与 S1/S3 的决定，
 * 不替代 PR-03 的构建切换或 PR-04 的 shell 屏障。
 */

const config = getConfig();
const storeRoot = runtimeStorePath(config.runtimeRoot);
/** `runtimeVirtualStore()` 返回容器内路径；宿主上的同一目录在 store 挂载源下面。 */
const virtualStoreOnHost = (app: { id: string; codeGenType: 'react_project' }) =>
  join(storeRoot, 'apps', appRuntimeKey(app), '.paimeng-virtual');
const containers: string[] = [];
const workspaces: string[] = [];
let userId: bigint;
const appIds: bigint[] = [];

type Fixture = { app: { id: string; codeGenType: 'react_project' }; root: string };
const fixtures: Fixture[] = [];

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
  const name = runtimeContainerName(fixture.app);
  const { uid, gid } = await stat(fixture.root);
  const args = runtimeRunArgs({
    app: fixture.app,
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

async function directorySize(path: string): Promise<number> {
  const { stdout } = await exec('du', ['-sb', path]);
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
  for (const container of containers) await removeContainer(container);
  for (const root of workspaces) await rm(root, { recursive: true, force: true });
  for (const appId of appIds) await db().delete(apps).where(eq(apps.id, appId));
  if (userId) await db().delete(users).where(eq(users.id, userId));
  await getPool().end();
}, 120_000);

describe('App runtime 执行环境', () => {
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

    const managed = await listManagedContainers('paimeng.managed-by');
    expect(managed.map((item) => item.name)).toContain(name);
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

    const storeBefore = await directorySize(storeRoot);

    const second = await newProject(await newAppRow());
    const nameB = await startContainer(second, image, { init: true });
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
    expect(incremental).toBeLessThanOrEqual(Math.max(firstShare * 0.2, 1024 * 1024));
  }, 600_000);

  it('--init 回收被遗留的孤儿进程；没有 --init 的控制组会累积僵尸', async () => {
    const image = await prepareRuntimeImage();
    const fixture = await newProject(await newAppRow());
    const name = (init: boolean) =>
      `${runtimeContainerName(fixture.app)}-${init ? 'init' : 'plain'}`;

    // 两组只差 --init 这一个开关。PID 1 用 sleep：它不回收孤儿，
    // 否则 busybox sh 自己会 wait 掉所有孩子，测不出 init 的作用。
    for (const init of [true, false]) {
      await removeContainer(name(init));
      await docker(
        [
          'run',
          '-d',
          ...(init ? ['--init'] : []),
          '--name',
          name(init),
          image.tag,
          'sleep',
          '100000',
        ],
        120_000,
      );
      containers.push(name(init));
    }

    await spawnOrphans(name(true));
    await spawnOrphans(name(false));
    expect(await zombieCount(name(true))).toBe(0);
    expect(await zombieCount(name(false))).toBeGreaterThan(0);
  }, 300_000);
});
