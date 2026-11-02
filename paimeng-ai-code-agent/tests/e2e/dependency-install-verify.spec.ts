import { test, expect, type FrameLocator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * #140 证据：模型在 App runtime 里用真实 pnpm 安装 registry 包，Preview 展示包功能；
 * 安装失败时把 shell 的可读原因交回模型。
 *
 * 链路：真实页面 → Next → harness（夹具模型）→ 真实 Docker runtime（pnpm + Vite dev server）→ 预览代理。
 * 夹具按提示词前缀决定脚本：`[install]` 执行 `pnpm add dayjs@1.11.13` 再把 dayjs 渲染进页面；
 * `[install-fail]` 安装一个不存在的包，并把 shell 的失败原因写进页面。联网步骤必须真实执行，
 * 跳过时本 spec 不算通过。
 */

loadEnvFile('.env');

const origin = appOrigin();
const account = 'verify_install_' + randomUUID().slice(0, 8);
const password = 'password123';
const suffix = account.slice(-8);
const evidence = evidenceDir('dependency-install');
const exec = promisify(execFile);
let db: pg.Client;
const createdApps: string[] = [];

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

async function deleteAppAndAssertStoreRemoved(page: import('@playwright/test').Page, id: string) {
  const index = createdApps.indexOf(id);
  if (index >= 0) createdApps.splice(index, 1);
  const response = await page.request.post('/api/app/delete', { headers: { origin }, data: { id } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).code).toBe(0);
  // 删除应用要回收共享 store 挂载里的 App virtual store；这条清理路径必须在用例里可见地断言。
  await expect(stat(join(process.cwd(), 'runtime/app-runtime/store/apps', `react_project_${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
}

test.afterEach(async ({ page }) => {
  // 用例中途失败时仍要清理；afterEach 的失败也会让 Playwright 把这个用例标成失败，不会吞掉。
  while (createdApps.length > 0) await deleteAppAndAssertStoreRemoved(page, createdApps[0]!);
});

test.afterAll(async () => { await db?.end(); });

function previewFrame(page: import('@playwright/test').Page): FrameLocator {
  return page.frameLocator('iframe.preview-frame');
}

async function login(page: import('@playwright/test').Page) {
  const registered = await page.request.post('/api/user/register', {
    headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');
}

async function createThickApp(page: import('@playwright/test').Page, prompt: string): Promise<string> {
  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('React 厚架子', { exact: true }).click();
  await page.getByLabel('应用描述').fill(prompt);
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
  const id = page.url().split('/').at(-1)!;
  createdApps.push(id);
  return id;
}

async function waitForSettled(page: import('@playwright/test').Page, title: string) {
  const frame = previewFrame(page);
  await expect(frame.getByText(title, { exact: false }).first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('文件已生成', { exact: false }).first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('button', { name: '可视化编辑' })).toBeEnabled({ timeout: 60_000 });
}

test('模型用 shell 真装 registry 包，Preview 显示包功能，锁文件与依赖标记来自轮末归一化', async ({ page }) => {
  test.setTimeout(480_000);
  const prompt = `[install] 依赖安装工作台_${suffix}`;
  await login(page);
  const appId = await createThickApp(page, prompt);
  await page.screenshot({ path: join(evidence, '01-app-created.png'), fullPage: true });

  const frame = previewFrame(page);
  // 页面导入 dayjs 并渲染固定日期：这段文字只能来自真实安装的包。
  await expect(frame.getByText('dayjs 渲染 2020年1月2日', { exact: false })).toBeVisible({ timeout: 240_000 });
  await page.screenshot({ path: join(evidence, '02-preview-package-feature.png'), fullPage: true });
  await waitForSettled(page, `依赖安装工作台_${suffix}`);
  await page.screenshot({ path: join(evidence, '03-generation-settled.png'), fullPage: true });

  const workspace = join(process.cwd(), 'runtime/code_output', 'react_project_' + appId);
  const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  expect(manifest.dependencies?.dayjs).toBe('1.11.13');
  const lock = await readFile(join(workspace, 'pnpm-lock.yaml'), 'utf8');
  expect(lock).toContain('dayjs@1.11.13');
  const { rows } = await db.query('select status, workspace_root, container_name from app_runtime where app_id = $1', [appId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('ready');
  expect(rows[0].workspace_root).toBe(workspace);
  // node_modules 的条目指向共享 store 挂载里的 virtual store：在容器里 follow 到真实文件。
  const dayjsModule = await exec('docker', ['exec', rows[0].container_name, 'sh', '-lc',
    'test -f node_modules/dayjs/package.json && readlink node_modules/dayjs'], { timeout: 60_000, encoding: 'utf8' });
  expect(dayjsModule.stdout.trim()).toContain('/store/apps/');

  // 轮末归一化会更新「镜像身份 + 锁文件哈希」安装标记；这里用独立计算的哈希核对。
  const digest = createHash('sha256').update(await readFile(join(workspace, 'pnpm-lock.yaml'))).digest('hex');
  const marker = JSON.parse(await readFile(join(workspace, '.paimeng-dependencies.json'), 'utf8')) as { imageIdentity: string; lockDigest: string };
  expect(marker.lockDigest).toBe(digest);
  expect(marker.imageIdentity).toContain('paimeng-app-runtime:');

  await writeFile(join(evidence, 'install-side-effects.json'), JSON.stringify({
    appId, dayjs: manifest.dependencies?.dayjs, lockHasDayjs: lock.includes('dayjs@1.11.13'), marker, runtime: rows[0],
    lockDigest: digest, dayjsModule: dayjsModule.stdout.trim(),
  }, null, 2));

  // 刷新后 Preview 仍能展示这个包的功能。
  await page.reload();
  await expect(previewFrame(page).getByText('dayjs 渲染 2020年1月2日', { exact: false })).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: join(evidence, '04-preview-after-refresh.png'), fullPage: true });
});

test('安装不存在的包时 shell 返回可读原因，模型能把原因写进 Preview', async ({ page }) => {
  test.setTimeout(480_000);
  const prompt = `[install-fail] 安装失败反馈_${suffix}`;
  await login(page);
  const appId = await createThickApp(page, prompt);

  const frame = previewFrame(page);
  await expect(frame.getByText('安装失败反馈', { exact: true })).toBeVisible({ timeout: 240_000 });
  // 夹具把 shell 输出里的错误行写进页面：说明模型确实拿到了可读的安装失败原因。
  await expect(frame.getByTestId('install-error')).toContainText(/ERR_PNPM|404|Not Found/i, { timeout: 60_000 });
  await page.screenshot({ path: join(evidence, '05-install-failure-feedback.png'), fullPage: true });
  await waitForSettled(page, `安装失败反馈_${suffix}`);
  await page.screenshot({ path: join(evidence, '06-install-failure-settled.png'), fullPage: true });

  const workspace = join(process.cwd(), 'runtime/code_output', 'react_project_' + appId);
  const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  expect(Object.keys(manifest.dependencies ?? {}).some(name => name.startsWith('pkm-missing-dependency-'))).toBe(false);
  const lock = await readFile(join(workspace, 'pnpm-lock.yaml'), 'utf8');
  expect(lock).not.toContain('pkm-missing-dependency-');
  await writeFile(join(evidence, 'install-failure-side-effects.json'), JSON.stringify({
    appId, dependencies: manifest.dependencies, lockHasMissingPackage: lock.includes('pkm-missing-dependency-'),
  }, null, 2));

  // 清理路径在用例主体里也跑一次：删除 App 后共享 store 里的 virtual store 必须消失。
  await deleteAppAndAssertStoreRemoved(page, appId);
  expect(createdApps).not.toContain(appId);
});
