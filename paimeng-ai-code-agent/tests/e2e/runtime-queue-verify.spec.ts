import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * #144 证据：运行时槽位排队、取消、自动出队、静态回落与下一轮惰性唤醒。
 *
 * 运行前提（由启动环境提供，不能由用例改服务端）：
 *   RUNTIME_MAX_SLOTS=1 RUNTIME_IDLE_TIMEOUT_MS=900000 RUNTIME_QUEUE_POLL_MS=500
 *   RUNTIME_SUPERVISOR_TICK_MS=1000 RUNTIME_QUEUE_WAIT_TIMEOUT_MS=600000
 * 空闲回收特意保持默认 15 分钟：本用例用「真实的等待者触发 LRU 驱逐」制造回落，
 * 不让定时回收抢在断言前面改变状态。
 *
 * 链路：真实页面 → Next → harness（夹具模型）→ 真实 Docker runtime（pnpm + Vite）→ 预览代理。
 * `[live-long]` 是夹具模型边界上的长窗口写文件脚本（20 秒），只用来保证「A 还在生成」时
 * 创建/取消/排队有确定的操作窗口；不替代任何队列或 authority 业务逻辑。
 */

loadEnvFile('.env');

const origin = appOrigin();
const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout.trim());
const account = 'verify_queue_' + randomUUID().slice(0, 8);
const password = 'password123';
const suffix = account.slice(-8);
const evidence = evidenceDir('runtime-queue');
const appIds: string[] = [];
let db: pg.Client;

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterEach(async ({ page }) => {
  for (const id of appIds.splice(0)) {
    await page.request.post('/api/app/generation/cancel', { headers: { origin }, data: { appId: id } }).catch(() => undefined);
    // 等取消真正落成终态再删应用：立刻删除会让执行/attempt 的收尾找不到父行（清理竞态噪音）。
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = await generationRow(id).catch(() => null);
      if (!row || ['ready', 'failed', 'cancelled'].includes(String(row.status))) break;
      await new Promise(done => setTimeout(done, 500));
    }
    await page.request.post('/api/app/delete', { headers: { origin }, data: { id } }).catch(() => undefined);
  }
});

test.afterAll(async () => { await db?.end(); });

async function registerAndLogin(page: Page) {
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

async function createApp(page: Page, prompt: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('技术栈', { exact: true }).click({ timeout: 30_000 });
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('React 厚架子', { exact: true }).click({ timeout: 20_000 });
  await page.getByLabel('应用描述').fill(prompt);
  await page.getByRole('button', { name: '创建应用', exact: true }).click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/, { timeout: 60_000 });
  const id = page.url().split('/').at(-1)!;
  appIds.push(id);
  return id;
}

/** 工具栏里还有一个技术栈 Tag（React 厚架子）；状态 Tag 按文案过滤，避免 strict mode 命中两个。 */
const statusTag = (page: Page) => page.locator('.chat-toolbar .ant-tag').filter({ hasText: /^(排队中|生成中|构建中|可预览|失败|已取消)$/ });

async function runtimeRow(appId: string) {
  const result = await db.query('select status, container_id, port, last_activity_at from app_runtime where app_id = $1', [appId]);
  return result.rows[0] ?? null;
}

async function generationRow(appId: string) {
  const result = await db.query('select id, status, error, stop_reason, deadline from generation where app_id = $1 order by create_time desc, id desc limit 1', [appId]);
  return result.rows[0] ?? null;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`等待超时：${label}`);
}

test('生成中创建的后一个应用排队、刷新保持、可取消；结后自动出队，被 LRU 驱逐后静态回落，下一轮惰性唤醒', async ({ page, context }) => {
  test.setTimeout(900_000);
  await registerAndLogin(page);

  // A 占住唯一槽位：[live-long] 让它在预览出现后还有约 20 秒的生成窗口，B 的排队/取消可以确定地发生。
  const promptA = `[live-long] 排队第一应用_${suffix}`;
  const appA = await createApp(page, promptA);
  await expect(statusTag(page)).toContainText('生成中', { timeout: 120_000 });
  await expect(page.locator('iframe.preview-frame')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('生成中，内容会持续更新', { exact: true })).toBeVisible({ timeout: 240_000 });

  // B 在 A 仍持有写权限时创建：没有槽位 → 持久化为 queued。
  const queuePage = await context.newPage();
  const appB = await createApp(queuePage, `排队被取消的应用_${suffix}`);
  await expect(statusTag(queuePage)).toContainText('排队中', { timeout: 60_000 });
  await expect(queuePage.getByText(/排队中 · .*运行时槽位/)).toBeVisible({ timeout: 30_000 });
  await queuePage.screenshot({ path: join(evidence, '01-queued.png'), fullPage: true });
  await writeFile(join(evidence, 'queue-state.json'), JSON.stringify({
    appA, appB, generationB: await generationRow(appB), runtimeA: await runtimeRow(appA),
  }, null, 2));

  // 刷新后排队仍在：排队是服务端持久状态，不是前端临时提示。
  await queuePage.reload();
  await expect(statusTag(queuePage)).toContainText('排队中', { timeout: 60_000 });
  await queuePage.screenshot({ path: join(evidence, '02-queued-after-refresh.png'), fullPage: true });

  // 取消等待：先确认它确实还在排队（A 仍生成、槽位未释放），再点取消；
  // 所有动作都带显式 timeout，按钮消失时立刻失败而不是无限等待。
  await expect(statusTag(queuePage)).toHaveText('排队中', { timeout: 10_000 });
  // antd 会在两个汉字的按钮里自动插空格（实际可访问名是「取 消」），只认这个形状；
  // 限定在输入区，避免命中弹窗里的同名按钮。
  await queuePage.locator('.chat-input').getByRole('button', { name: /^取\s*消$/ }).click({ timeout: 20_000 });
  await expect(statusTag(queuePage)).toContainText('已取消', { timeout: 60_000 });
  await queuePage.screenshot({ path: join(evidence, '03-queue-cancelled.png'), fullPage: true });
  expect((await db.query('select 1 from app_runtime_queue where app_id = $1', [appB])).rowCount).toBe(0);
  expect((await generationRow(appB))?.status).toBe('cancelled');

  // A 第一轮结束；再发一轮 [live-long]，为 C 的「排队 → 自动出队」制造确定窗口。
  await expect(statusTag(page)).toContainText('可预览', { timeout: 300_000 });
  await page.getByLabel('对话消息').fill(`[live-long] 排队第一应用第二轮_${suffix}`);
  await page.getByLabel('对话消息').press('Enter');
  await expect(statusTag(page)).toContainText('生成中', { timeout: 60_000 });

  const wakePage = await context.newPage();
  const appC = await createApp(wakePage, `排队后自动启动的应用_${suffix}`);
  await expect(statusTag(wakePage)).toContainText('排队中', { timeout: 60_000 });
  await wakePage.screenshot({ path: join(evidence, '04-second-queued.png'), fullPage: true });
  expect((await generationRow(appC))?.status).toBe('queued');
  // A 收束后，C 的等待者会在下一次轮询里拿到空间（A 已无写权限，是唯一可驱逐的 runtime）。
  await expect(statusTag(wakePage)).toContainText('生成中', { timeout: 240_000 });
  await wakePage.screenshot({ path: join(evidence, '05-auto-started.png'), fullPage: true });
  await expect(statusTag(wakePage)).toContainText('可预览', { timeout: 300_000 });
  await expect(wakePage.locator('iframe.preview-frame')).toBeVisible({ timeout: 120_000 });
  await wakePage.screenshot({ path: join(evidence, '06-preview-ready.png'), fullPage: true });

  // 记录 LRU 事实：创建 D 之前，只有 C 有现存的 runtime；A 已被 C 的等待者驱逐，B 从未启动容器。
  const appRuntimes = await db.query(
    'select app_id, status, last_activity_at from app_runtime where app_id = any($1::bigint[]) order by last_activity_at',
    [[appA, appB, appC]],
  );
  expect(appRuntimes.rows.filter(row => row.status === 'ready').map(row => String(row.app_id))).toEqual([appC]);
  await writeFile(join(evidence, 'lru-candidates.json'), JSON.stringify({ appA, appB, appC, runtimes: appRuntimes.rows }, null, 2));

  // 依赖标记留在持久 Workspace 里：唤醒后还能看到它，证明从同一份 Workspace 继续。
  const workspacePath = `runtime/code_output/react_project_${appC}`;
  await mkdir(join(process.cwd(), workspacePath, 'node_modules'), { recursive: true });
  await writeFile(join(process.cwd(), workspacePath, 'node_modules/.paimeng-wake-marker'), 'persisted');
  const readyC = await runtimeRow(appC);
  expect(readyC?.status).toBe('ready');

  // D 创建后，它的等待者在下一次轮询就按 LRU 驱逐唯一的候选 C（这就是预览睡眠的原因，不是定时回收）。
  // 不再断言瞬时的「排队中」：D 的排队最多存在半个 poll tick，页面渲染完时通常已经自动启动；
  // 排队 UX 由 A/B 的长窗口证明，这里断言驱逐与自动启动的可观察结果。
  const limitPage = await context.newPage();
  const appD = await createApp(limitPage, `触发驱逐的等待应用_${suffix}`);
  await waitFor(async () => (await runtimeRow(appC))?.status === 'stopped', 120_000, 'C 被 LRU 驱逐');
  const containerGone = await docker(['inspect', '--format', '{{.State.Running}}', `paimeng-app-runtime-react_project_${appC}`]).catch(() => 'missing');
  expect(containerGone).toBe('missing');
  // 创建应用的自动提交可能还在路上：等 D 的 Generation 行落库再查转移，避免拿到 null。
  await waitFor(async () => (await generationRow(appD)) !== null, 60_000, 'D 的 Generation 落库');
  const dGeneration = await generationRow(appD);
  const dTransitions = await db.query(
    'select from_state, to_state, reason from generation_transition where generation_id = $1 order by create_time, id',
    [dGeneration?.id],
  );
  // 排队事实由落库的转移记录证明（insert 时 null→queued，获得槽位时 queued→generating），不伪造瞬时 UI。
  expect(dTransitions.rows.some(row => row.to_state === 'queued')).toBe(true);
  expect(dTransitions.rows.some(row => row.from_state === 'queued' && row.to_state === 'generating')).toBe(true);
  await writeFile(join(evidence, 'lru-eviction.json'), JSON.stringify({
    runtimeC: await runtimeRow(appC), containerC: containerGone, generationD: dGeneration, transitionsD: dTransitions.rows,
  }, null, 2));
  await limitPage.screenshot({ path: join(evidence, '07-evicted-by-waiter.png'), fullPage: true });
  // 自动启动的可见结果：D 不刷新、不重发也走到可预览。
  await expect(statusTag(limitPage)).toContainText('可预览', { timeout: 300_000 });
  await expect(limitPage.locator('iframe.preview-frame')).toBeVisible({ timeout: 120_000 });

  // 刷新 C：Preview 用真实生成构建产物回落；查看不会唤醒 runtime，也不会开启新 Generation。
  // 静态产物本身的证据：dist 里的构建结果包含本轮需求文案，证明回落读的是平台构建产物而不是空壳。
  const distAssets = await readdir(join(process.cwd(), workspacePath, 'dist', 'assets'));
  let buildContainsPrompt = false;
  for (const asset of distAssets) {
    if ((await readFile(join(process.cwd(), workspacePath, 'dist', 'assets', asset), 'utf8')).includes(`排队后自动启动的应用_${suffix}`)) buildContainsPrompt = true;
  }
  expect(buildContainsPrompt).toBe(true);
  await writeFile(join(evidence, 'static-build.json'), JSON.stringify({ distAssets, buildContainsPrompt }, null, 2));
  await wakePage.reload();
  await expect(wakePage.locator('iframe.preview-frame')).toBeVisible({ timeout: 120_000 });
  await expect(wakePage.frameLocator('iframe.preview-frame').getByText(`排队后自动启动的应用_${suffix}`, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  expect(await runtimeRow(appC)).toMatchObject({ status: 'stopped' });
  expect((await generationRow(appC))?.status).toBe('ready');
  await wakePage.screenshot({ path: join(evidence, '08-static-fallback.png'), fullPage: true });
  await writeFile(join(evidence, 'static-fallback.json'), JSON.stringify({
    runtimeC: await runtimeRow(appC), generationC: await generationRow(appC), container: containerGone, buildContainsPrompt,
  }, null, 2));

  // 通过界面外接口清掉 D（应用删除入口的同一条业务链）：先取消它这一轮，再删除应用；
  // 删除会停掉 D 的 runtime，让 C 的下一轮能拿到槽位。这是界面代劳，报告里列明。
  await limitPage.request.post('/api/app/generation/cancel', { headers: { origin }, data: { appId: appD } });
  const deleted = await limitPage.request.post('/api/app/delete', { headers: { origin }, data: { id: appD } });
  expect(deleted.ok()).toBe(true);
  const dIndex = appIds.indexOf(appD);
  if (dIndex >= 0) appIds.splice(dIndex, 1);

  // 下一轮惰性唤醒：发一条新需求，runtime 从持久 Workspace 重建，依赖标记仍在。
  // 不抓瞬时的 `生成中`：夹具写文件很快，页面轮询可能直接看到 `构建中`/`可预览`。
  // 新轮次的证据用落库的 generation id + 最终 ready + 重建后的容器身份，而不是瞬时标签。
  const nextPrompt = `排队后自动启动的应用_${suffix} 第二轮`;
  const previousGeneration = await generationRow(appC);
  await wakePage.getByLabel('对话消息').fill(nextPrompt);
  await wakePage.getByLabel('对话消息').press('Enter');
  await waitFor(async () => {
    const current = await generationRow(appC);
    return current !== null && current.id !== previousGeneration?.id;
  }, 120_000, '新一轮 Generation 落库');
  const wakeGenerationId = (await generationRow(appC))?.id;
  await waitFor(async () => (await generationRow(appC))?.status === 'ready', 300_000, '新一轮 Generation 完成');
  await waitFor(async () => (await runtimeRow(appC))?.status === 'ready', 120_000, '唤醒后的 runtime');
  const marker = await readFile(join(process.cwd(), workspacePath, 'node_modules/.paimeng-wake-marker'), 'utf8');
  expect(marker).toBe('persisted');
  const woken = await runtimeRow(appC);
  expect(woken?.container_id).not.toBe(readyC?.container_id);
  await expect(wakePage.frameLocator('iframe.preview-frame').getByText(nextPrompt, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
  await expect(statusTag(wakePage)).toContainText('可预览', { timeout: 60_000 });
  await wakePage.screenshot({ path: join(evidence, '09-woken-next-round.png'), fullPage: true });
  await writeFile(join(evidence, 'wake.json'), JSON.stringify({
    runtime: woken,
    generation: await generationRow(appC),
    generationIdAfterWake: wakeGenerationId,
    previousGenerationId: previousGeneration?.id,
    dependencyMarker: marker,
    previousContainerId: readyC?.container_id,
  }, null, 2));
});
