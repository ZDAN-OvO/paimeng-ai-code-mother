import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createServer as createNetServer } from 'node:net';
import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import type { Server } from 'node:http';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, users } from '@/server/infra/schema';
import { initializeTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate } from '@/server/templates/templates';
import { ensureRuntime, ensureSafeDirectory, workspace } from '@/server/workspace/workspace';
import { getConfig } from '@/server/infra/config';
import { ensureAppRuntime, stopAppRuntime } from '@/server/app-runtime/supervisor';
import { deleteApp } from '@/server/business';
import { publicUser } from '@/server/auth/auth';
import { readAppRuntime } from '@/server/app-runtime/store';
import { appRuntimeKey, runtimeContainerName, runtimePaths, runtimeStorePath } from '@/server/app-runtime/plan';
import { createPreviewServer } from '@/server/delivery/preview';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout.trim());

const template = resolveTemplate('react-ts', '2.0.0');
const appsUnderTest = [
  { id: '', codeGenType: 'react_project' as const },
  { id: '', codeGenType: 'react_project' as const },
];
const marker = (label: string) => `运行时实时更新-${label}-${randomUUID().slice(0, 6)}`;
let userId: bigint;
let browser: Browser;
let preview: Server;
let previewPort = 0;
const previousOrigin = process.env.PREVIEW_ORIGIN;

const homeSource = (title: string) => `import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function HomePage() {
  return (
    <div className="space-y-8">
      <PageHeader title="${title}" description="system 测试写入的页面" />
      <Card>
        <CardHeader><CardTitle>实时预览</CardTitle></CardHeader>
        <CardContent><p data-testid="runtime-marker">${title}</p></CardContent>
      </Card>
    </div>
  );
}
`;

function freePort() {
  const probe = createNetServer();
  return new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForText(page: import('playwright').Page, text: string, timeout = 30_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

beforeAll(async () => {
  userId = await nextSnowflakeId();
  await db().insert(users).values({ id: userId, userAccount: 'ts_app_runtime_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  for (const app of appsUnderTest) {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: 'App runtime system', codeGenType: app.codeGenType, userId, createTime: now(), updateTime: now() });
    app.id = id.toString();
    // initializeTemplate 自己创建应用目录（非空目录会拒绝覆盖），这里只铺好它的父目录。
    await ensureSafeDirectory(join(await ensureRuntime(), 'code_output'));
    await initializeTemplate(app, template);
  }
  browser = await chromium.launch({ headless: true, timeout: 30_000 });
});

afterAll(async () => {
  for (const app of appsUnderTest) {
    if (!app.id) continue;
    await stopAppRuntime(app).catch(() => undefined);
    const paths = runtimePaths(getConfig().runtimeRoot, app);
    await rm(paths.base, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
    await db().delete(apps).where(eq(apps.id, BigInt(app.id))).catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  if (preview) await new Promise<void>(resolve => preview.close(() => resolve())).catch(() => undefined);
  if (userId) await db().delete(users).where(eq(users.id, userId)).catch(() => undefined);
  if (previousOrigin === undefined) delete process.env.PREVIEW_ORIGIN;
  else process.env.PREVIEW_ORIGIN = previousOrigin;
  await getPool().end().catch(() => undefined);
});

describe('真实 Docker 上的 App runtime', () => {
  it('按宿主 uid 启动、只挂自己的 Workspace 与 store、提供 pnpm/git，容器写出的文件宿主用户能处理', async () => {
    const app = appsUnderTest[0];
    const view = await ensureAppRuntime({ app, workspaceRoot: workspace(app) });
    expect(view.status).toBe('ready');
    expect(view.port).toBeGreaterThan(0);
    const record = await readAppRuntime(app);
    expect(record).toMatchObject({ status: 'ready', workspaceRoot: workspace(app) });
    expect(record?.imageIdentity).toContain('paimeng-app-runtime:');

    const [inspect] = JSON.parse(await docker(['inspect', runtimeContainerName(app)])) as [{
      Config: { User: string; Env: string[] };
      HostConfig: { NetworkMode: string };
      Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
    }];
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    expect(inspect.Config.User).toBe(`${uid}:${gid}`);
    const mounts = inspect.Mounts.filter(item => item.Type === 'bind');
    expect(mounts.map(item => item.Destination).sort()).toEqual(['/store', '/work', '/work/node_modules']);
    expect(mounts.find(item => item.Destination === '/work')?.Source).toBe(workspace(app));
    expect(mounts.find(item => item.Destination === '/work/node_modules')?.Source).toBe(runtimePaths(getConfig().runtimeRoot, app).nodeModules);
    expect(mounts.find(item => item.Destination === '/store')?.Source).toBe(runtimeStorePath(getConfig().runtimeRoot));
    expect(mounts.every(item => item.RW)).toBe(true);
    expect(mounts.some(item => item.Source.includes('docker.sock'))).toBe(false);
    // 网络按父 spec 放开：不是 none，也不是只留 loopback。
    expect(inspect.HostConfig.NetworkMode).not.toBe('none');
    // 不注入平台环境变量。
    const env = inspect.Config.Env.join('\n');
    for (const secret of ['DATABASE_URL', 'REDIS_URL', 'APP_ORIGIN', 'PREVIEW_ORIGIN', 'AI_API_KEY', 'MODEL_SECRET_KEY', 'DURABLE_PG_URL']) {
      expect(env).not.toContain(secret);
    }
    expect(env).toContain('COREPACK_HOME=/store/corepack');

    // 镜像自带 pnpm 与 git；容器以宿主 uid 执行，写出的文件宿主用户能读、能删。
    expect((await docker(['exec', runtimeContainerName(app), 'sh', '-lc', 'pnpm --version'])).trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await docker(['exec', runtimeContainerName(app), 'sh', '-lc', 'git --version'])).trim()).toContain('git version');
    await docker(['exec', runtimeContainerName(app), 'sh', '-lc', 'printf container-owned > from-container.txt']);
    const written = join(workspace(app), 'from-container.txt');
    const info = await stat(written);
    expect(info.uid).toBe(uid);
    expect(info.gid).toBe(gid);
    expect(await readFile(written, 'utf8')).toBe('container-owned');
    await rm(written);
    await expect(stat(written)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 600_000);

  it('Preview 通过代理服务真实 dev server：连续两次源码修改都出现在浏览器里，不同 App 不串用', async () => {
    const [first, second] = appsUnderTest;
    const firstTitle = marker('第一次');
    const secondTitle = marker('第二次');
    await writeFile(join(workspace(first), 'src/pages/home.tsx'), homeSource(firstTitle));
    const firstRuntime = await readAppRuntime(first);
    expect(firstRuntime?.status).toBe('ready');

    previewPort = await freePort();
    // createPreviewServer 在构造时读取 PREVIEW_ORIGIN，先占端口再设来源。
    process.env.PREVIEW_ORIGIN = `http://127.0.0.1:${previewPort}`;
    preview = await createPreviewServer({ runtimeRoot: getConfig().runtimeRoot });
    await new Promise<void>((resolve, reject) => { preview.once('error', reject); preview.listen(previewPort, '127.0.0.1', resolve); });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${previewPort}/preview/${appRuntimeKey(first)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForText(page, firstTitle, 60_000);
      // 第二次修改：不刷新页面，HMR websocket 必须把更新送进来。
      const secondEdit = marker('第二次修改');
      await writeFile(join(workspace(first), 'src/pages/home.tsx'), homeSource(secondEdit));
      await waitForText(page, secondEdit, 60_000);
      expect(await page.getByText(firstTitle, { exact: false }).count()).toBe(0);

      // 第二个 App 有独立的容器与端口，内容不会串。
      const secondView = await ensureAppRuntime({ app: second, workspaceRoot: workspace(second) });
      expect(secondView.status).toBe('ready');
      expect(secondView.port).not.toBe(firstRuntime?.port);
      await writeFile(join(workspace(second), 'src/pages/home.tsx'), homeSource(secondTitle));
      const other = await context.newPage();
      await other.goto(`http://127.0.0.1:${previewPort}/preview/${appRuntimeKey(second)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForText(other, secondTitle, 60_000);
      expect(await other.getByText(secondEdit, { exact: false }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 900_000);

  it('写入基线切换（下一次执行的源码根）时重建容器，新容器只挂新的执行目录', async () => {
    const app = appsUnderTest[0];
    const previous = await readAppRuntime(app);
    expect(previous?.status).toBe('ready');
    const nextRoot = join(getConfig().runtimeRoot, 'executions', 'system-baseline', '1');
    await rm(nextRoot, { recursive: true, force: true });
    await cp(workspace(app), nextRoot, {
      recursive: true,
      filter: source => !/\/(node_modules|dist)(\/|$)/.test(source) && !/\/(\.git|\.paimeng-)/.test(source),
    });
    const oldTitle = marker('旧基线');
    const newTitle = marker('新基线');
    await writeFile(join(workspace(app), 'src/pages/home.tsx'), homeSource(oldTitle));
    await writeFile(join(nextRoot, 'src/pages/home.tsx'), homeSource(newTitle));

    const view = await ensureAppRuntime({ app, workspaceRoot: nextRoot });
    expect(view.status).toBe('ready');
    expect(view.workspaceRoot).toBe(nextRoot);
    expect(view.containerId).not.toBe(previous?.containerId);
    const [inspect] = JSON.parse(await docker(['inspect', runtimeContainerName(app)])) as [{
      Mounts: { Type: string; Source: string; Destination: string }[];
    }];
    const work = inspect.Mounts.find(item => item.Type === 'bind' && item.Destination === '/work');
    expect(work?.Source).toBe(nextRoot);
    // 新容器上跑着新基线的 dev server：旧执行目录的内容不再可达。
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const messages: string[] = [];
      page.on('console', message => { if (message.type() === 'error') messages.push(message.text()); });
      page.on('pageerror', error => messages.push('pageerror: ' + error.message));
      const response = await page.goto(`http://127.0.0.1:${view.port}/preview/${appRuntimeKey(app)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      try {
        // 新容器首次启动时 Vite 可能正在优化依赖；给它一次重新加载的机会，
        // 仍然看不到新基线标题才算“换基线没有生效”。
        await waitForText(page, newTitle, 20_000);
      } catch {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        try { await waitForText(page, newTitle, 40_000); }
        catch (error) {
          console.error('baseline page failed', response?.status(), messages, await page.locator('body').innerText().catch(() => ''));
          throw error;
        }
      }
      expect(await page.getByText(oldTitle, { exact: false }).count()).toBe(0);
    } finally {
      await context.close();
    }
    await rm(nextRoot, { recursive: true, force: true });
    // 后续用例继续用应用工作区作为源码根。
    expect((await ensureAppRuntime({ app, workspaceRoot: workspace(app) })).status).toBe('ready');
  }, 600_000);

  it('删除应用时停掉它的 runtime 容器', async () => {
    const app = appsUnderTest[1];
    expect((await ensureAppRuntime({ app, workspaceRoot: workspace(app) })).status).toBe('ready');
    const [row] = await db().select().from(users).where(eq(users.id, userId));
    await deleteApp({ id: app.id }, publicUser(row));
    const state = await docker(['inspect', '--format', '{{.State.Running}}', runtimeContainerName(app)]).catch(() => 'missing');
    expect(state).toBe('missing');
    expect(await readAppRuntime(app)).toBeNull();
  }, 600_000);

  it('容器停止后宿主文件仍在，下一轮复用已安装依赖', async () => {
    const app = appsUnderTest[0];
    const record = await readAppRuntime(app);
    expect(record?.status).toBe('ready');
    const nodeModules = runtimePaths(getConfig().runtimeRoot, app).nodeModules;
    const installedMarker = join(nodeModules, '.paimeng-installed-marker');
    await writeFile(installedMarker, 'installed');
    const source = await readFile(join(workspace(app), 'src/pages/home.tsx'), 'utf8');

    await docker(['rm', '-f', runtimeContainerName(app)]);
    // 记录还在但容器没了：下一轮必须重建容器，而不是继续代理一个死端口。
    const rebuilt = await ensureAppRuntime({ app, workspaceRoot: workspace(app) });
    expect(rebuilt.status).toBe('ready');
    expect(rebuilt.containerId).not.toBe(record?.containerId);
    expect(await readFile(join(workspace(app), 'src/pages/home.tsx'), 'utf8')).toBe(source);
    expect(await readFile(installedMarker, 'utf8')).toBe('installed');
    expect((await docker(['exec', runtimeContainerName(app), 'sh', '-lc', 'test -x node_modules/.bin/vite && echo ok'])).trim()).toBe('ok');
    const response = await fetch(`http://127.0.0.1:${rebuilt.port}/preview/${appRuntimeKey(app)}/`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
  }, 600_000);
});
