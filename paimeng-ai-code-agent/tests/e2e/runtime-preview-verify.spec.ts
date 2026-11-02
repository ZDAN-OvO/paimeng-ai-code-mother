import { test, expect, type FrameLocator, type WebSocket } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * #139 证据：在真实 App runtime 里生成，Preview 实时显示源码修改。
 *
 * 链路：真实页面 → Next → harness → 真实 Docker runtime（Vite dev server）→ 预览反向代理。
 * 模型仍是仓库夹具（`DURABLE_FAUX_FIXTURE=1`）：提示词以 `[live]` 开头时，夹具在同一轮里
 * 连续写两次 `src/pages/home.tsx`，中间等待 8 秒，所以「先看到第一版、再看到第二版」只能来自
 * dev server 的文件监听与 HMR websocket，而不是构建完成后的静态产物。
 */

loadEnvFile('.env');

const origin = appOrigin();
const account = 'verify_runtime_' + randomUUID().slice(0, 8);
const password = 'password123';
const suffix = account.slice(-8);
const prompt = `[live] 实时预览工作台_${suffix}`;
const firstTitle = `实时预览工作台_${suffix} · 第一版`;
const secondTitle = `实时预览工作台_${suffix} · 第二版`;
const evidence = evidenceDir('runtime-preview');
const outputRoot = join(process.cwd(), 'runtime/code_output');
let appId = '';
let db: pg.Client;

const exec = promisify(execFile);

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  if (appId) {
    // 清理只针对本次创建的应用：容器、工作区、运行时台账与数据库行。
    const [runtime] = await db?.query('select container_name from app_runtime where app_id = $1', [appId]).then(result => result.rows).catch(() => []) ?? [];
    if (runtime?.container_name) await exec('docker', ['rm', '-f', runtime.container_name]).catch(() => undefined);
    await db?.query('delete from app where id = $1', [appId]).catch(() => undefined);
    await rm(join(outputRoot, `react_project_${appId}`), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(process.cwd(), 'runtime/app-runtime', `react_project_${appId}`), { recursive: true, force: true }).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

/** iframe 里的预览文档：与测试主页不同源，操作都走 frameLocator。 */
function previewFrame(page: import('@playwright/test').Page): FrameLocator {
  return page.frameLocator('iframe.preview-frame');
}

test('生成中 Preview 连续显示两次写入，生成期间只读，收束后可编辑且刷新保持', async ({ page }) => {
  test.setTimeout(420_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // 登录前后存在预期内的 401（未登录读取会话/账单），只记录不当成失败；CSP 与脚本错误必须为零。
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  // 记录预览代理上的 HMR websocket：断言更新是通过这条连接送进来的。
  const sockets: { url: string; frames: string[] }[] = [];
  page.on('websocket', (socket: WebSocket) => {
    const record = { url: socket.url(), frames: [] as string[] };
    sockets.push(record);
    socket.on('framereceived', event => { if (record.frames.length < 40) record.frames.push(String(event.payload)); });
  });

  const registered = await page.request.post('/api/user/register', {
    headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');

  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('React 厚架子', { exact: true }).click();
  await page.getByLabel('应用描述').fill(prompt);
  await page.screenshot({ path: join(evidence, '01-home-filled.png'), fullPage: true });
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
  appId = page.url().split('/').at(-1)!;

  // 运行时准备（镜像/依赖/dev server）在模型开始写文件之前完成，所以 iframe 会在第一版写入前后出现。
  const frame = previewFrame(page);
  await expect(page.locator('iframe.preview-frame')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('生成中，内容会持续更新', { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(frame.getByText(firstTitle, { exact: false }).first()).toBeVisible({ timeout: 180_000 });
  // 代理注入的桥接脚本必须真的执行了；Generation 持有写权限期间它是锁住的。
  await expect(frame.locator('html')).toHaveAttribute('data-paimeng-editor', 'locked');
  await page.screenshot({ path: join(evidence, '02-preview-first-write.png'), fullPage: true });

  // 只读是行为而不是文案：即使宿主页强推「打开编辑」，生成期间点元素也不能被选中。
  await page.evaluate(() => {
    const target = document.querySelector('iframe.preview-frame') as HTMLIFrameElement | null;
    target?.contentWindow?.postMessage({ type: 'TOGGLE_EDIT_MODE', editMode: true, locked: true }, '*');
  });
  await frame.locator('h1').first().click({ force: true });
  await page.waitForTimeout(300);
  expect(await frame.locator('body').evaluate(() => document.querySelectorAll('.paimeng-edit-selected').length)).toBe(0);
  await expect(frame.locator('html')).toHaveAttribute('data-paimeng-editor', 'locked');

  // 页面级探针：HMR 更新不刷新文档，所以这个值必须活到第二版出现。
  await page.evaluate(() => { (window as unknown as { __runtimeProbe?: number }).__runtimeProbe = 1; });
  await expect(frame.getByText(secondTitle, { exact: false }).first()).toBeVisible({ timeout: 180_000 });
  expect(await page.evaluate(() => (window as unknown as { __runtimeProbe?: number }).__runtimeProbe)).toBe(1);
  await page.screenshot({ path: join(evidence, '03-preview-second-write.png'), fullPage: true });
  await writeFile(join(evidence, 'hmr-websockets.json'), JSON.stringify(sockets, null, 2));

  // 生成期间预览只读：可视化编辑按钮禁用。
  const editButton = page.getByRole('button', { name: /可视化编辑|退出编辑/ });
  if (await page.getByText('生成中，内容会持续更新', { exact: true }).count()) {
    await expect(editButton).toBeDisabled();
    await page.screenshot({ path: join(evidence, '04-readonly-while-generating.png'), fullPage: true });
  }

  // 生成收束（构建 + 发布完成）。
  await expect(page.getByText('文件已生成', { exact: false }).first()).toBeVisible({ timeout: 240_000 });
  await expect(editButton).toBeEnabled({ timeout: 60_000 });
  await expect(editButton).toHaveText('可视化编辑');

  // 收束后恢复编辑：进入编辑模式并点选一个元素，预览把选择上报回宿主页。
  // 代理注入的编辑桥接必须真的在预览文档里；收束后宿主页解锁，点选才生效。
  await expect(frame.locator('script[data-paimeng-editor]')).toHaveCount(1);
  await expect(frame.locator('html')).toHaveAttribute('data-paimeng-editor', 'ready', { timeout: 15_000 });
  await editButton.click();
  await expect(editButton).toHaveText('退出编辑');
  await expect(frame.locator('html')).toHaveAttribute('data-paimeng-editor', 'on', { timeout: 15_000 });
  await expect(frame.locator('#paimeng-editor-style')).toHaveCount(1, { timeout: 15_000 });
  await frame.locator('h1').first().click();
  await expect.poll(() => frame.locator('body').evaluate(() => document.querySelectorAll('.paimeng-edit-selected').length)).toBe(1);
  await expect(page.getByText(/已选中 1 个元素/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(evidence, '05-editing-after-settle.png'), fullPage: true });

  // HMR websocket 确实经过预览代理，并收到过 Vite 的更新帧。
  const runtimeSockets = sockets.filter(socket => /\/preview\/react_project_\d+\//.test(socket.url));
  expect(runtimeSockets.length).toBeGreaterThan(0);
  expect(runtimeSockets.some(socket => socket.frames.some(frame => frame.includes('"type"')))).toBe(true);

  // 刷新后：源码、预览与编辑能力都来自同一份持久状态。
  await page.reload();
  await expect(page.locator('iframe.preview-frame')).toBeVisible({ timeout: 120_000 });
  await expect(previewFrame(page).getByText(secondTitle, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: '可视化编辑' })).toBeEnabled({ timeout: 60_000 });
  await page.screenshot({ path: join(evidence, '06-after-refresh.png'), fullPage: true });

  // 运行时台账与 Workspace：容器仍在、端口与源码根对应这次执行。
  const { rows } = await db.query(
    'select status, port, image_identity, workspace_root, container_name from app_runtime where app_id = $1', [appId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('ready');
  expect(rows[0].port).toBeGreaterThan(0);
  expect(rows[0].image_identity).toContain('paimeng-app-runtime:');
  expect(rows[0].workspace_root).toContain('/executions/');
  const userPage = await page.request.get('/api/app/get/vo?id=' + appId, { headers: { origin } });
  expect(userPage.ok()).toBe(true);
  expect((await userPage.json()).data.previewUrl).toContain('/preview/react_project_' + appId + '/');
  await writeFile(join(evidence, 'runtime-row.json'), JSON.stringify(rows, null, 2));

  // 第二轮：同一 App 再生成一次。执行目录会换（容器因此重建），但每个 App 的 node_modules
  // 与共享 pnpm store 是持久的——用容器里的标记文件证明“没有重新装一份依赖”。
  const reuseMarker = '.paimeng-reuse-marker';
  await exec('docker', ['exec', rows[0].container_name, 'sh', '-lc', `printf reused > node_modules/${reuseMarker}`]);
  const secondPrompt = '第二轮复用验证_' + suffix;
  await page.getByLabel('对话消息').fill(secondPrompt);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('生成中，内容会持续更新', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(previewFrame(page).getByText(secondPrompt, { exact: false }).first()).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: join(evidence, '07-second-round-live.png'), fullPage: true });
  await expect(page.getByText('文件已生成', { exact: false }).first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('button', { name: '可视化编辑' })).toBeEnabled({ timeout: 60_000 });
  const { rows: secondRows } = await db.query(
    'select status, workspace_root, container_name from app_runtime where app_id = $1', [appId],
  );
  expect(secondRows[0].status).toBe('ready');
  expect(secondRows[0].workspace_root).not.toBe(rows[0].workspace_root);
  const marker = await exec('docker', ['exec', secondRows[0].container_name, 'sh', '-lc', `cat node_modules/${reuseMarker}`]);
  expect(marker.stdout.trim()).toBe('reused');
  await writeFile(join(evidence, 'second-round-runtime.json'), JSON.stringify({ marker: marker.stdout.trim(), ...secondRows[0] }, null, 2));
  await page.screenshot({ path: join(evidence, '08-second-round-settled.png'), fullPage: true });

  await writeFile(join(evidence, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter(text => /Content Security Policy|Uncaught|data-paimeng-editor/i.test(text))).toEqual([]);
});
