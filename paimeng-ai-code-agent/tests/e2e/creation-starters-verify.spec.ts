import { test, expect, type FrameLocator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * #138 证据：首页分别用「轻量静态页」和「React 厚架子」创建应用，各自生成、构建、预览。
 *
 * 模型是仓库夹具（`DURABLE_FAUX_FIXTURE=1`）：它把这次需求写进产物 `<h1>`。React 厚架子的夹具
 * 只改写 `src/pages/home.tsx`，布局、设计令牌、组件与路由都来自模板本身，所以「侧栏还在 +
 * 标题等于需求 + 能路由跳转」能同时证明模板内容与本次生成。
 */

loadEnvFile('.env');

const origin = appOrigin();
const account = 'verify_starter_' + randomUUID().slice(0, 8);
const password = 'password123';
const suffix = account.slice(-8);
const lightPrompt = '轻量静态展示_' + suffix;
const reactPrompt = '厚架子工作台_' + suffix;
const evidence = evidenceDir('creation-starters');
const outputRoot = join(process.cwd(), 'runtime/code_output');
const created: { id: string; codeGenType: 'html' | 'react_project' }[] = [];
let db: pg.Client;

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  for (const app of created) await rm(join(outputRoot, `${app.codeGenType}_${app.id}`), { recursive: true, force: true }).catch(() => undefined);
  for (const app of created) await db?.query('delete from app where id = $1', [app.id]).catch(() => undefined);
  await db?.end().catch(() => undefined);
});

async function tokenValues(preview: FrameLocator) {
  return preview.locator('body').evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const card = document.querySelector('[data-slot="card"]');
    return {
      brand: root.getPropertyValue('--color-brand').trim(),
      fontSans: root.getPropertyValue('--font-sans').trim(),
      radiusCard: root.getPropertyValue('--radius-card').trim(),
      bodyBackground: body.backgroundColor,
      cardRadius: card ? getComputedStyle(card).borderRadius : null,
    };
  });
}

test('首页创建轻量静态页与 React 厚架子，各自生成、构建、预览并刷新后保留', async ({ page }) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  const registered = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');

  // 首页只提供两个显式选项，自动选择另有说明。
  await page.getByLabel('技术栈', { exact: true }).click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await expect(dropdown.locator('.ant-select-item-option')).toHaveCount(3);
  for (const name of ['自动选择', '轻量静态页', 'React 厚架子']) await expect(dropdown.getByText(name, { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '01-home-starters.png'), fullPage: true });
  await dropdown.getByText('轻量静态页', { exact: true }).click();
  await expect(page.getByText('单文件静态页，无需构建，适合内容简单的单页站点', { exact: true })).toBeVisible();

  // 路径一：轻量静态页。
  await page.getByLabel('应用描述').fill(lightPrompt);
  const lightRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/app/add');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  const lightBody = (await lightRequest).postDataJSON() as { initPrompt: string; templateId?: string };
  expect(lightBody).toEqual({ initPrompt: lightPrompt, templateId: 'html' });
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
  const lightId = page.url().split('/').at(-1)!;
  created.push({ id: lightId, codeGenType: 'html' });
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  const lightPreview = page.frameLocator('iframe[title="应用预览"]');
  await expect(lightPreview.getByRole('heading', { name: lightPrompt, exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '02-light-generated.png'), fullPage: true });

  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(lightPreview.getByRole('heading', { name: lightPrompt, exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '03-light-after-reload.png'), fullPage: true });

  // 路径二：React 厚架子。真实 pnpm 安装与 Vite 构建，首次构建比静态页慢。
  await page.goto('/');
  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('React 厚架子', { exact: true }).click();
  await expect(page.getByText('React + Vite + Tailwind + shadcn/ui 骨架，含布局、设计令牌、路由与示例页面', { exact: true })).toBeVisible();
  await page.getByLabel('应用描述').fill(reactPrompt);
  const reactRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/app/add');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  const reactBody = (await reactRequest).postDataJSON() as { initPrompt: string; templateId?: string };
  expect(reactBody).toEqual({ initPrompt: reactPrompt, templateId: 'react-ts' });
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
  const reactId = page.url().split('/').at(-1)!;
  created.push({ id: reactId, codeGenType: 'react_project' });
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 300_000 });

  const reactPreview = page.frameLocator('iframe[title="应用预览"]');
  await expect(reactPreview.getByRole('heading', { name: reactPrompt, exact: true })).toBeVisible();
  // 布局与组件来自模板：侧栏、品牌、卡片。
  await expect(reactPreview.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(reactPreview.getByText('Paimeng Studio')).toBeVisible();
  await expect(reactPreview.locator('[data-slot="card"]').first()).toBeVisible();
  const tokens = await tokenValues(reactPreview);
  // Tailwind 输出会压缩数字：oklch(55% .15 32)，断言色相与饱和度而不是书写形式。
  expect(tokens.brand).toMatch(/(?:0\.55|55%)/);
  expect(tokens.brand).toContain('32');
  expect(tokens.fontSans).toContain('PingFang SC');
  expect(tokens.radiusCard).toBe('1rem');
  expect(tokens.cardRadius).toBe('16px');
  expect(tokens.bodyBackground).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: join(evidence, '04-react-generated.png'), fullPage: true });

  // 路由导航可用：关于骨架 → 回到工作台（HashRouter，静态托管下也能直接刷新）。
  await reactPreview.getByRole('link', { name: '关于骨架' }).click();
  await expect(reactPreview.getByRole('heading', { name: '关于这个骨架', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '05-react-route-about.png'), fullPage: true });
  await reactPreview.getByRole('link', { name: '工作台' }).click();
  await expect(reactPreview.getByRole('heading', { name: reactPrompt, exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(reactPreview.getByRole('heading', { name: reactPrompt, exact: true })).toBeVisible();
  await expect(reactPreview.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.screenshot({ path: join(evidence, '06-react-after-reload.png'), fullPage: true });

  // 副作用：两次 ready 的 Generation、两个 App 的类型与模板，以及工作区里的真实文件。
  const rows = await db.query<{ id: string; code_gen_type: string; status: string }>(
    `select a.id::text as id, a.code_gen_type, g.status
       from app a join generation g on g.app_id = a.id
      where a.id = any($1::bigint[])`,
    [[lightId, reactId]],
  );
  const lightRow = rows.rows.find(row => row.id === lightId);
  const reactRow = rows.rows.find(row => row.id === reactId);
  expect(lightRow).toMatchObject({ code_gen_type: 'html', status: 'ready' });
  expect(reactRow).toMatchObject({ code_gen_type: 'react_project', status: 'ready' });

  const lightSource = await readFile(join(outputRoot, `html_${lightId}`, 'index.html'), 'utf8');
  expect(lightSource).toContain(lightPrompt);
  const reactRoot = join(outputRoot, `react_project_${reactId}`);
  const reactPage = await readFile(join(reactRoot, 'src/pages/home.tsx'), 'utf8');
  expect(reactPage).toContain(reactPrompt);
  expect(reactPage).toContain('@/components/layout/page-header');
  const reactShell = await readFile(join(reactRoot, 'src/components/layout/app-shell.tsx'), 'utf8');
  expect(reactShell).toContain('主导航');
  const reactTokens = await readFile(join(reactRoot, 'src/index.css'), 'utf8');
  expect(reactTokens).toContain('@theme');
  const reactLock = await readFile(join(reactRoot, 'pnpm-lock.yaml'), 'utf8');
  expect(reactLock).toContain('lockfileVersion');
  const reactManifest = JSON.parse(await readFile(join(reactRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  expect(reactManifest.dependencies).not.toHaveProperty('antd');

  await writeFile(join(evidence, 'facts.json'), JSON.stringify({
    account,
    light: { appId: lightId, request: lightBody, source: `runtime/code_output/html_${lightId}/index.html`, sourceContainsPrompt: lightSource.includes(lightPrompt) },
    react: {
      appId: reactId,
      request: reactBody,
      source: `runtime/code_output/react_project_${reactId}/src/pages/home.tsx`,
      sourceContainsPrompt: reactPage.includes(reactPrompt),
      tokens,
      lockfile: `runtime/code_output/react_project_${reactId}/pnpm-lock.yaml`,
    },
    generations: rows.rows,
    capturedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  expect(errors).toEqual([]);
});
