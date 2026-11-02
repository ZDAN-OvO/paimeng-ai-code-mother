import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * #144 证据（容量反馈）：排队满与排队等待超时的可读界面反馈，以及等待不产生 Credit / 不延长 Deadline。
 *
 * 运行前提（由启动环境提供）：
 *   RUNTIME_MAX_SLOTS=1 RUNTIME_QUEUE_LIMIT=1 RUNTIME_QUEUE_WAIT_TIMEOUT_MS=12000
 *   RUNTIME_QUEUE_POLL_MS=500 RUNTIME_SUPERVISOR_TICK_MS=1000 RUNTIME_IDLE_TIMEOUT_MS=600000
 *   GENERATION_TIMEOUT_MS=900000
 * 第一个 App 用 [live-long] 夹具占住唯一槽位并持有写权限 → 它不会被驱逐，等待者才有机会超时。
 */

loadEnvFile('.env');

const origin = appOrigin();
const account = 'verify_queue_limit_' + randomUUID().slice(0, 8);
const password = 'password123';
const suffix = account.slice(-8);
const evidence = evidenceDir('runtime-queue-limits');
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
    await page.request.post('/api/app/delete', { headers: { origin }, data: { id } }).catch(() => undefined);
  }
});

test.afterAll(async () => { await db?.end(); });

const statusTag = (page: Page) => page.locator('.chat-toolbar .ant-tag').filter({ hasText: /^(排队中|生成中|构建中|可预览|失败|已取消)$/ });

/** 当前账号的账本基线：队列期间 Charge 与 entry 都不该增加。 */
async function accountLedger(account: string) {
  // 只比较真正的扣减事实（Charge 金额与 entry 条数）：另一个 App 结束时产生的 0 元待处理账单不算消耗。
  const result = await db.query(`select coalesce(sum(c.credits), 0)::bigint as credits
    from credit_charge c join app_user u on u.id = c.user_id where u.user_account = $1`, [account]);
  const entries = await db.query(`select count(*)::int as entries
    from credit_entry e join credit_charge c on c.generation_id = e.charge_id join app_user u on u.id = c.user_id
    where u.user_account = $1`, [account]);
  return { credits: Number(result.rows[0].credits), entries: Number(entries.rows[0].entries) };
}

async function createApp(page: Page, prompt: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('技术栈', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('React 厚架子', { exact: true }).click();
  await page.getByLabel('应用描述').fill(prompt);
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/chat\/\d+$/, { timeout: 60_000 });
  const id = page.url().split('/').at(-1)!;
  appIds.push(id);
  return id;
}

test('队列满与排队超时给出可读反馈；等待不改写 Deadline、不产生 Credit', async ({ page, context }) => {
  test.setTimeout(600_000);
  const registered = await page.request.post('/api/user/register', {
    headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');

  // 第一个 App 占住唯一槽位并持有写权限（生成中），等待者既不会被驱赶，也必须自己等。
  const appA = await createApp(page, `[live-long] 排队满与超时的占用者_${suffix}`);
  await expect(statusTag(page)).toContainText('生成中', { timeout: 120_000 });
  expect(['active', 'draining']).toContain((await db.query('select state from app_authority where app_id = $1', [appA])).rows[0]?.state);

  // 等待者 B：进入队列。队列期间的账本基线必须保持不变。
  const ledgerBefore = await accountLedger(account);
  const waitPage = await context.newPage();
  const appB = await createApp(waitPage, `排队超时的应用_${suffix}`);
  await expect(statusTag(waitPage)).toContainText('排队中', { timeout: 60_000 });
  const queued = (await db.query(
    'select q.wait_deadline, q.enqueued_at, g.deadline, g.status from app_runtime_queue q join generation g on g.id = q.generation_id where q.app_id = $1',
    [appB],
  )).rows[0];
  expect(queued).toBeTruthy();
  expect(queued.status).toBe('queued');
  // 等待截止取「入队 + RUNTIME_QUEUE_WAIT_TIMEOUT_MS」与 Generation 绝对 Deadline 的较小值，不延长 Deadline。
  const timeOf = (value: Date | string) => value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T') + 'Z');
  expect(timeOf(queued.wait_deadline)).toBeLessThanOrEqual(timeOf(queued.deadline));
  expect(timeOf(queued.wait_deadline) - timeOf(queued.enqueued_at)).toBeLessThanOrEqual(12_500);
  const queuedCharge = await db.query('select count(*)::int as count from credit_charge c join generation g on g.id = c.generation_id where g.app_id = $1', [appB]);
  expect(queuedCharge.rows[0].count).toBe(0);
  expect(await accountLedger(account)).toEqual(ledgerBefore);
  await waitPage.screenshot({ path: join(evidence, '01-queued-waiting-timeout.png'), fullPage: true });

  // 队列上限 1：第二个等待者的创建被明确拒绝，页面给出可读原因。
  const fullPage = await context.newPage();
  await createApp(fullPage, `队列已满的应用_${suffix}`);
  await expect(fullPage.getByText(/排队已满/)).toBeVisible({ timeout: 60_000 });
  await fullPage.screenshot({ path: join(evidence, '02-queue-full.png'), fullPage: true });
  const fullId = appIds.at(-1)!;
  expect((await db.query('select app_id from app_runtime_queue where app_id = $1', [fullId])).rows).toHaveLength(0);
  // 队列满在准入阶段被拒：不会留下 Generation 行（也不会产生任何待结算账单）。
  expect((await db.query('select id from generation where app_id = $1', [fullId])).rows).toHaveLength(0);

  // B 的等待超时：落 failed/timeout，界面显示可读原因，排队记录消失。
  await expect(statusTag(waitPage)).toContainText('失败', { timeout: 120_000 });
  await expect(waitPage.getByText(/排队等待超时/)).toBeVisible({ timeout: 30_000 });
  await waitPage.screenshot({ path: join(evidence, '03-queue-timeout.png'), fullPage: true });
  const generation = (await db.query('select id, status, stop_reason, error, deadline from generation where app_id = $1 order by create_time desc, id desc limit 1', [appB])).rows[0];
  expect(generation).toMatchObject({ status: 'failed', stop_reason: 'timeout' });
  expect(generation.error).toContain('排队等待超时');
  expect(generation.deadline).not.toBeNull();
  // 失败不改写绝对 Deadline：落库值与入队时完全相同（等待不延长时限）。
  expect(timeOf(generation.deadline)).toBe(timeOf(queued.deadline));
  expect((await db.query('select 1 from app_runtime_queue where app_id = $1', [appB])).rowCount).toBe(0);
  // 排队等待不产生 Credit：这一轮从来没有执行过（0 个 generation_step、0 条成交分录），
  // 账号级账本与入队前完全一致。Charge 行即使存在也是 0 元待处理账单（faux 缺价），不拿它单独当证明。
  const steps = (await db.query('select count(*)::int as count from generation_step where generation_id = $1', [generation.id])).rows[0].count;
  expect(steps).toBe(0);
  const charge = (await db.query('select credits, status from credit_charge where generation_id = $1', [generation.id])).rows[0];
  expect(charge?.credits ?? 0).toBe(0);
  const ledgerAfter = await accountLedger(account);
  expect(ledgerAfter).toEqual(ledgerBefore);
  await writeFile(join(evidence, 'queue-limits.json'), JSON.stringify({
    queued, generation, steps, charge, ledgerBefore, ledgerAfter, fullAppGenerationRows: 0,
  }, null, 2));
});
