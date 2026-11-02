import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, users } from '@/server/infra/schema';
import { initializeTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate } from '@/server/templates/templates';
import { getConfig } from '@/server/infra/config';
import { ensureRuntime, ensureSafeDirectory, readProjectFile, workspace, writeProjectFile } from '@/server/workspace/workspace';
import { ensureAppRuntime, stopAppRuntime } from '@/server/app-runtime/supervisor';
import { runRuntimeShell } from '@/server/app-runtime/shell';
import { finalizeRuntimeDependencies } from '@/server/app-runtime/dependencies';
import { appRuntimeKey, runtimeAppDataPath, runtimeContainerName, runtimeVirtualStore } from '@/server/app-runtime/plan';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 真实 Docker + 真实 pnpm：开放依赖的安装与轮末归一化。
 *
 * 断言外部结果：包出现在 package.json / pnpm-lock.yaml / node_modules，两个 App 的依赖文件是
 * 同一个宿主 store 的硬链接；并发安装不破坏另一个 App；清单与锁文件对不上时这一轮明确失败。
 * 这一组需要 npm registry 出网；离线机器上会失败，报告必须如实标注「装包未覆盖」。
 */

const template = resolveTemplate('react-ts', '2.0.0');
const appsUnderTest = [
  { id: '', codeGenType: 'react_project' as const },
  { id: '', codeGenType: 'react_project' as const },
];
let userId: bigint;

const exec = promisify(execFile);
/** node_modules 里的包是指向 /store virtual store 的相对符号链接：容器里 follow，宿主上只能看 virtual store。 */
const dockerExec = (app: (typeof appsUnderTest)[number], command: string) =>
  exec('docker', ['exec', runtimeContainerName(app), 'sh', '-lc', command], { timeout: 60_000, encoding: 'utf8' }).then(result => result.stdout.trim());
const virtualStoreOf = async (app: (typeof appsUnderTest)[number]) =>
  stat(join(virtualStoreHostPath(app), 'dayjs@1.11.13/node_modules/dayjs/package.json'));
const virtualStoreHostPath = (app: (typeof appsUnderTest)[number]) =>
  join(runtimeAppDataPath(getConfig().runtimeRoot, app), '.paimeng-virtual');
const manifestOf = async (app: (typeof appsUnderTest)[number]) => JSON.parse(await readProjectFile(app, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const lockOf = (app: (typeof appsUnderTest)[number]) => readFile(join(workspace(app), 'pnpm-lock.yaml'), 'utf8');
const lockDigest = async (app: (typeof appsUnderTest)[number]) => createHash('sha256').update(await readFile(join(workspace(app), 'pnpm-lock.yaml'))).digest('hex');
const markerOf = async (app: (typeof appsUnderTest)[number]) => JSON.parse(await readFile(join(workspace(app), '.paimeng-dependencies.json'), 'utf8')) as { imageIdentity: string; lockDigest: string };

beforeAll(async () => {
  userId = await nextSnowflakeId();
  await db().insert(users).values({ id: userId, userAccount: 'ts_app_deps_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  for (const app of appsUnderTest) {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: 'App dependencies system', codeGenType: app.codeGenType, userId, createTime: now(), updateTime: now() });
    app.id = id.toString();
    await ensureSafeDirectory(join(await ensureRuntime(), 'code_output'));
    await initializeTemplate(app, template);
  }
  for (const app of appsUnderTest) {
    expect((await ensureAppRuntime({ app, workspaceRoot: workspace(app) })).status).toBe('ready');
  }
}, 900_000);

afterAll(async () => {
  for (const app of appsUnderTest) {
    if (!app.id) continue;
    await stopAppRuntime(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
    await db().delete(apps).where(eq(apps.id, BigInt(app.id))).catch(() => undefined);
  }
  if (userId) await db().delete(users).where(eq(users.id, userId)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('真实 pnpm 安装与轮末归一化', () => {
  it('模型用 shell 装 registry 包：清单、锁文件与 node_modules 都更新，两个 App 通过硬链接共享宿主 store', async () => {
    for (const app of appsUnderTest) {
      const result = await runRuntimeShell({ app, command: 'pnpm add dayjs@1.11.13 --reporter=append-only' });
      expect(result.exitCode, result.output).toBe(0);
    }
    for (const app of appsUnderTest) {
      expect((await manifestOf(app)).dependencies?.dayjs).toBe('1.11.13');
      expect(await lockOf(app)).toContain('dayjs@1.11.13');
      // node_modules 里是真实条目（指向 /store virtual store 的相对符号链接），容器里能解析到文件。
      expect(await dockerExec(app, 'stat -Lc "%F %i %h" node_modules/dayjs/package.json')).toMatch(/^regular/);
      expect(await dockerExec(app, `node -e "import('dayjs').then(m => console.log(m.default('2020-01-02').format('YYYY年M月D日')))"`)).toBe('2020年1月2日');
    }
    // 同一个内容寻址 store 文件被两个 App 的 virtual store 硬链接：inode 相同，链接数至少 2。
    const first = await virtualStoreOf(appsUnderTest[0]);
    const second = await virtualStoreOf(appsUnderTest[1]);
    expect(second.ino).toBe(first.ino);
    expect(first.nlink).toBeGreaterThanOrEqual(2);
    // virtual store 位于共享 store 挂载内（否则跨设备无法硬链接）。
    expect(await dockerExec(appsUnderTest[0], `test -d ${runtimeVirtualStore(appsUnderTest[0])} && echo inside-store`)).toBe('inside-store');
    const store = await runRuntimeShell({ app: appsUnderTest[0], command: 'test -d /store/v10/files && echo store-ready' });
    expect(store.output).toContain('store-ready');
  }, 900_000);

  it('两个 App 并发安装同一个包不会互相破坏', async () => {
    const [first, second] = appsUnderTest;
    const [firstRun, secondRun] = await Promise.all([
      runRuntimeShell({ app: first, command: 'pnpm add nanoid@5.0.9 --reporter=append-only' }),
      runRuntimeShell({ app: second, command: 'pnpm add nanoid@5.0.9 --reporter=append-only' }),
    ]);
    expect(firstRun.exitCode, firstRun.output).toBe(0);
    expect(secondRun.exitCode, secondRun.output).toBe(0);
    for (const app of appsUnderTest) {
      expect(await dockerExec(app, 'test -f node_modules/nanoid/package.json && echo file')).toBe('file');
      // dev server 仍能响应：安装没有把另一个 App 的依赖树弄坏。
      const preview = await fetch(`http://127.0.0.1:${(await ensureAppRuntime({ app, workspaceRoot: workspace(app) })).port}/preview/${appRuntimeKey(app)}/`, { signal: AbortSignal.timeout(20_000) });
      expect(preview.status).toBeLessThan(500);
    }
  }, 900_000);

  it('轮末归一化让手改的 package.json 与锁文件对齐，合规 overrides 可以通过', async () => {
    const app = appsUnderTest[0];
    const manifest = await manifestOf(app) as { dependencies?: Record<string, string>; pnpm?: Record<string, unknown> };
    // left-pad 不是模板的传递依赖：direct importer 出现它才能证明归一化写回了清单。
    manifest.dependencies = { ...manifest.dependencies, 'left-pad': '1.3.0' };
    manifest.pnpm = { ...manifest.pnpm, overrides: { dayjs: '1.11.13' } };
    await writeProjectFile(app, 'package.json', JSON.stringify(manifest, null, 2));
    expect(await lockOf(app)).not.toContain('left-pad');

    await finalizeRuntimeDependencies({ app, workspaceRoot: workspace(app) });
    expect(await lockOf(app)).toContain('      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0');
    expect(await lockOf(app)).toContain('overrides:');
    expect(await dockerExec(app, 'test -f node_modules/left-pad/package.json && echo file')).toBe('file');
    expect((await markerOf(app)).lockDigest).toBe(await lockDigest(app));
  }, 900_000);

  it('清单与锁文件无法对齐时明确失败，不产出成功产物', async () => {
    const app = appsUnderTest[0];
    const before = await lockOf(app);
    const beforeMarker = await markerOf(app);
    const manifest = await manifestOf(app);
    // 已知事实：pnpm.overrides 会覆盖 direct dependency（上一用例把 dayjs 钉在 1.11.13）。
    // 因此这个用例改用一个没有被 overrides 覆盖的包，两个用例互不依赖，也不动上一个用例的断言。
    manifest.dependencies = { ...manifest.dependencies, 'left-pad': '999.999.999' };
    await writeProjectFile(app, 'package.json', JSON.stringify(manifest, null, 2));
    const failure = await finalizeRuntimeDependencies({ app, workspaceRoot: workspace(app) })
      .then(() => null, error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toMatch(/依赖安装失败|依赖归一化失败/);
    // 诊断要带出无法解析的包名与版本，模型才知道改哪里。
    expect(failure!.message).toMatch(/left-pad/);
    expect(failure!.message).toMatch(/999\.999\.999/);
    expect(await lockOf(app)).toBe(before);
    expect(await markerOf(app)).toEqual(beforeMarker);
    expect(await lockOf(app)).not.toContain('999.999.999');
    // 失败后用可解析的版本重新归一化能恢复。
    manifest.dependencies = { ...manifest.dependencies, 'left-pad': '^1.3.0' };
    await writeProjectFile(app, 'package.json', JSON.stringify(manifest, null, 2));
    await finalizeRuntimeDependencies({ app, workspaceRoot: workspace(app) });
    expect((await markerOf(app)).lockDigest).toBe(await lockDigest(app));
  }, 900_000);

  it('拒绝 .npmrc 与 registry 以外的依赖来源', async () => {
    const app = appsUnderTest[0];
    const manifestText = await readProjectFile(app, 'package.json');

    // .npmrc 不在文件工具的允许路径里，直接用宿主文件模拟 shell 写出来的文件。
    await writeFile(join(workspace(app), '.npmrc'), 'registry=https://evil.invalid/');
    await expect(finalizeRuntimeDependencies({ app, workspaceRoot: workspace(app) })).rejects.toThrow(/不允许 \.npmrc/);
    await rm(join(workspace(app), '.npmrc'), { force: true });

    const manifest = JSON.parse(manifestText) as { dependencies: Record<string, string> };
    manifest.dependencies.vite = 'git+https://github.com/user/repo.git';
    await writeProjectFile(app, 'package.json', JSON.stringify(manifest));
    await expect(finalizeRuntimeDependencies({ app, workspaceRoot: workspace(app) })).rejects.toThrow(/依赖来源不被允许/);
    await writeProjectFile(app, 'package.json', manifestText);
  }, 900_000);

  it('锁文件哈希变化时，下一次 ensureAppRuntime 在提供 Preview 前重装依赖', async () => {
    const app = appsUnderTest[1];
    const added = await runRuntimeShell({ app, command: 'pnpm add ms@2.1.3 --reporter=append-only' });
    expect(added.exitCode, added.output).toBe(0);
    // 模拟「容器里的 node_modules 丢了」：标记仍指向旧锁文件，锁文件已被 pnpm 改过。
    await rm(join(workspace(app), 'node_modules/ms'), { force: true });
    expect((await markerOf(app)).lockDigest).not.toBe(await lockDigest(app));

    const view = await ensureAppRuntime({ app, workspaceRoot: workspace(app) });
    expect(view.status).toBe('ready');
    expect(await dockerExec(app, 'test -f node_modules/ms/package.json && echo file')).toBe('file');
    expect((await markerOf(app)).lockDigest).toBe(await lockDigest(app));
  }, 900_000);
});
