import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * verify-paimeng-agent 证据：首页创建应用 → 生成 → 预览。
 *
 * 走真实 Next + harness + 预览服务；模型是仓库夹具（`DURABLE_FAUX_FIXTURE=1`），
 * 夹具把这次的需求文本写进产物 `<h1>`，所以「预览标题 == 需求」能证明页面内容来自这次生成，
 * 而不是模板页或上一轮的残留。
 *
 * 四张图对应四步：填好需求、点击后刚进对话页、生成完成、「刷新之后还在」。
 */

loadEnvFile('.env');

const origin = appOrigin();
const workspaceRoot = process.cwd();
const account = 'verify_gen_' + randomUUID().slice(0, 8);
const password = 'password123';
const prompt = '生成验证_' + account.slice(-8);
const evidence = evidenceDir('generation');
const workspaceDir = join(workspaceRoot, 'runtime/code_output', 'html_');

let appId = '';
let db: pg.Client;

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  if (appId) {
    await rm(workspaceDir + appId, { recursive: true, force: true }).catch(() => undefined);
    await db.query('delete from app where id = $1', [appId]).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

test('首页填写需求后生成出可预览的页面，刷新后仍在', async ({ page }) => {
  test.setTimeout(180_000);
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

  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('轻量静态页', { exact: true }).click();
  await expect(page.getByText('单文件静态页，无需构建，适合内容简单的单页站点', { exact: true })).toBeVisible();
  await page.getByLabel('应用描述').fill(prompt);
  await page.screenshot({ path: join(evidence, '01-home-filled.png'), fullPage: true });

  const created = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/app/add');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  const createBody = (await created).postDataJSON() as { initPrompt: string; templateId?: string };
  expect(createBody).toEqual({ initPrompt: prompt, templateId: 'html' });

  await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
  appId = page.url().split('/').at(-1)!;
  await page.screenshot({ path: join(evidence, '02-after-create.png'), fullPage: true });

  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(page.locator('.message-ai .tool-call').first()).toBeVisible();
  await expect(page.locator('.message-ai .tool-call').filter({ hasText: '写入文件' }).first()).toBeVisible();
  // 预览里的标题就是这次的需求：证明产物来自这次输入，不是静态模板。
  await expect(page.frameLocator('iframe[title="应用预览"]').getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '03-generated.png'), fullPage: true });

  // 副作用：库里一次 ready 的 generation，attempt 账本里有模型与工具调用；工作区真的写出了文件。
  const generation = await db.query<{ status: string }>('select status from generation where app_id = $1', [appId]);
  expect(generation.rows).toEqual([{ status: 'ready' }]);
  const attempts = await db.query<{ kind: string; count: number }>(
    `select a.kind, count(*)::int as count
       from generation_attempt a
       join generation_execution e on e.id = a.execution_id
      where e.app_id = $1
      group by a.kind`,
    [appId],
  );
  const counts = Object.fromEntries(attempts.rows.map(row => [row.kind, row.count]));
  expect(counts.model, '模型 attempt 应已落账').toBeGreaterThanOrEqual(1);
  expect(counts.tool, '工具 attempt 应已落账').toBeGreaterThanOrEqual(1);
  const source = await readFile(join(workspaceDir + appId, 'index.html'), 'utf8');
  expect(source).toContain(prompt);

  // 副作用落成文件：报告里的数字要能对上一个 spec 自己写下的快照，而不是事后粘贴。
  await writeFile(join(evidence, 'db-facts.json'), JSON.stringify({
    appId,
    prompt,
    generation: generation.rows,
    attemptsByKind: counts,
    sourcePath: `runtime/code_output/html_${appId}/index.html`,
    sourceBytes: Buffer.byteLength(source),
    sourceContainsPrompt: source.includes(prompt),
    capturedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await expect(page.getByText(/文件已生成/)).toBeVisible();
  await expect(page.frameLocator('iframe[title="应用预览"]').getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, '04-after-reload.png'), fullPage: true });

  expect(errors).toEqual([]);
});
