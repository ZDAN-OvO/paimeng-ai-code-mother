import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * 单账本积分的功能证明：管理员选人 → 发放 → 刷新 → 筛选/规则/操作日志；
 * Owner 看到同一份数；账单冲正后余额回到结算前。
 * 账单与账本行由 SQL 夹具写入 `_test`，结算本身由 tests/integration/billing 覆盖。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const createdUserIds: string[] = [];
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];

async function register(page: Page, account: string): Promise<string> {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
  const envelope = await response.json() as { code: number; data: string };
  expect(envelope.code).toBe(0);
  createdUserIds.push(envelope.data);
  return envelope.data;
}

async function login(page: Page, account: string) {
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/');
}

async function adminLogin(page: Page, account: string) {
  await register(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await login(page, account);
}

async function selectUser(page: Page, account: string) {
  const search = page.getByLabel('搜索用户');
  await search.fill(account);
  await search.press('Enter');
  const row = page.getByRole('button').filter({ hasText: account }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText(account);
}

function saveJson(name: string, value: unknown) {
  writeFileSync(evidencePath('billing', name), JSON.stringify(value, null, 2));
}

async function ledgerOf(userId: string) {
  const connection = await testConnection();
  try {
    const { rows } = await connection.query(
      `select id, kind, origin, credits, period, expires_at, reason
       from credit_ledger where user_id = $1 order by id`, [userId],
    );
    const { rows: balances } = await connection.query(
      'select available, next_expiry_at from credit_balance where user_id = $1', [userId],
    );
    return { rows, balance: balances[0] ?? null };
  } finally {
    await connection.end();
  }
}

/** 造一个 App + 一笔 60 积分的已结算账单：当期发放 100 → 消费 60 → 可用 40。 */
async function seedSettledCharge(ownerId: string): Promise<{ appName: string; generationId: string }> {
  const appId = String(BigInt(Date.now()) * 100n + BigInt(Math.floor(Math.random() * 100)));
  const generationId = randomUUID();
  createdApps.push(BigInt(appId));
  createdGenerations.push(generationId);
  const connection = await testConnection();
  try {
    await connection.query(
      `INSERT INTO app (id, app_name, init_prompt, code_gen_type, user_id, create_time, update_time)
       VALUES ($1, '积分证明应用', '做一个页面', 'html', $2, timezone('UTC', now())::timestamp(3), timezone('UTC', now())::timestamp(3))`,
      [appId, ownerId],
    );
    await connection.query(
      `INSERT INTO generation (id, app_id, user_id, status, stop_reason, create_time, update_time)
       VALUES ($1, $2, $3, 'ready', 'completed', timezone('UTC', now())::timestamp(3), timezone('UTC', now())::timestamp(3))`,
      [generationId, appId, ownerId],
    );
    await connection.query(
      `INSERT INTO credit_charge (generation_id, app_id, user_id, credits, cost_usd, rate_card_snapshot, usage_snapshot, status, estimated_steps, create_time)
       VALUES ($1, $2, $3, 60, NULL, '[]'::jsonb, '[]'::jsonb, 'settled', 0, timezone('UTC', now())::timestamp(3))`,
      [generationId, appId, ownerId],
    );
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1', [ownerId]);
    await connection.query(
      `INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, create_time)
       SELECT $1, 'quota', 'rule', 100,
         to_char(timezone('UTC', now()) + interval '8 hours', 'YYYY-MM'),
         (date_trunc('month', timezone('UTC', now()) + interval '8 hours') + interval '1 month' - interval '8 hours'),
         timezone('UTC', now())::timestamp(3)`,
      [ownerId],
    );
    await connection.query(
      `INSERT INTO credit_ledger (user_id, kind, origin, credits, charge_id, period, expires_at, create_time)
       SELECT $1, 'consume', 'charge', -60, $2, l.period, l.expires_at, timezone('UTC', now())::timestamp(3)
       FROM credit_ledger l WHERE l.user_id = $1 AND l.kind = 'quota'`,
      [ownerId, generationId],
    );
    await connection.query(
      `INSERT INTO credit_balance (user_id, available, next_expiry_at, update_time)
       SELECT $1, 40, min(expires_at), timezone('UTC', now())::timestamp(3)
       FROM credit_ledger WHERE user_id = $1 AND period IS NOT NULL
       ON CONFLICT (user_id) DO UPDATE SET available = EXCLUDED.available, next_expiry_at = EXCLUDED.next_expiry_at`,
      [ownerId],
    );
  } finally {
    await connection.end();
  }
  return { appName: '积分证明应用', generationId };
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdGenerations.length) {
      await connection.query('DELETE FROM credit_ledger WHERE charge_id = ANY($1::text[])', [createdGenerations]);
      await connection.query('DELETE FROM credit_charge WHERE generation_id = ANY($1::text[])', [createdGenerations]);
      await connection.query('DELETE FROM generation WHERE id = ANY($1::text[])', [createdGenerations]);
    }
    if (createdApps.length) await connection.query('DELETE FROM app WHERE id = ANY($1::bigint[])', [createdApps]);
    if (createdUserIds.length) {
      await connection.query('DELETE FROM credit_ledger WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_balance WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_operation WHERE operator_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_quota_policy WHERE created_by = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
    }
  } finally {
    await connection.end();
  }
});

test('管理员选人、发放限时/长期积分：流水、可用额与刷新后的状态一致', async ({ page }) => {
  const account = 'verify_credit_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, account);
  await adminLogin(page, 'verify_credit_admin_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  await expect(page.getByRole('heading', { name: '积分管理' })).toBeVisible();
  await selectUser(page, account);

  const detail = page.getByRole('region', { name: '用户积分详情' });
  await expect(detail).toContainText('500');
  await expect(detail).toContainText('已发');
  await expect(detail).toContainText('每月规则');
  await page.screenshot({ path: evidencePath('billing', '01-selected-initial.png'), fullPage: true });

  await page.getByRole('button', { name: '发放限时积分' }).click();
  await page.getByLabel('数量（积分）').fill('300');
  await page.getByLabel('理由（写进流水）').fill('证明：限时积分补偿');
  await page.getByRole('button', { name: '确认发放' }).click();
  await expect(detail).toContainText('+300');
  await expect(detail).toContainText('证明：限时积分补偿');
  await expect(detail).toContainText('800');
  await page.screenshot({ path: evidencePath('billing', '02-issued-limited.png'), fullPage: true });

  const afterIssue = await ledgerOf(ownerId);
  saveJson('ledger-after-issue.json', afterIssue);
  expect(afterIssue.rows.map(row => [row.kind, row.origin, Number(row.credits)])).toEqual([
    ['quota', 'rule', 500],
    ['quota', 'manual', 300],
  ]);
  expect(Number(afterIssue.balance?.available)).toBe(800);

  await page.reload();
  await selectUser(page, account);
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('800');
  await page.screenshot({ path: evidencePath('billing', '03-after-reload.png'), fullPage: true });

  await page.getByRole('button', { name: '发放长期积分' }).click();
  await page.getByLabel('数量（积分）').fill('200');
  await page.getByLabel('理由（写进流水）').fill('证明：长期积分赠送');
  await page.getByRole('button', { name: '确认发放' }).click();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('+200');
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('1000');
  await page.screenshot({ path: evidencePath('billing', '04-issued-lasting.png'), fullPage: true });
});

test('待发/欠款筛选、改规则与最近操作都能落到界面', async ({ page }) => {
  const pendingAccount = 'verify_credit_pending_' + randomUUID().slice(0, 8);
  const pendingId = await register(page, pendingAccount);
  const debtAccount = 'verify_credit_debt_' + randomUUID().slice(0, 8);
  const debtId = await register(page, debtAccount);
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1', [pendingId]);
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1', [debtId]);
    await connection.query(
      `INSERT INTO credit_ledger (user_id, kind, origin, credits, create_time)
       VALUES ($1, 'grant', 'manual', -50, timezone('UTC', now())::timestamp(3))`, [debtId],
    );
    await connection.query(
      `INSERT INTO credit_balance (user_id, available, next_expiry_at, update_time)
       VALUES ($1, -50, NULL, timezone('UTC', now())::timestamp(3))
       ON CONFLICT (user_id) DO UPDATE SET available = -50, next_expiry_at = NULL`, [debtId],
    );
  } finally {
    await connection.end();
  }
  await adminLogin(page, 'verify_credit_admin2_' + randomUUID().slice(0, 8));
  const adminCookie = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

  await page.goto('/admin/billing');
  const search = page.getByLabel('搜索用户');

  await page.locator('.ant-segmented').getByText('待发', { exact: true }).click();
  await search.fill(pendingAccount);
  await search.press('Enter');
  await expect(page.getByRole('button').filter({ hasText: pendingAccount }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('待发');
  await page.screenshot({ path: evidencePath('billing', '05-filter-pending.png'), fullPage: true });

  await page.locator('.ant-segmented').getByText('欠款', { exact: true }).click();
  await search.fill(debtAccount);
  await search.press('Enter');
  await expect(page.getByRole('button').filter({ hasText: debtAccount }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('-50');
  await page.screenshot({ path: evidencePath('billing', '06-filter-debt.png'), fullPage: true });

  await page.locator('.ant-segmented').getByText('待发', { exact: true }).click();
  await search.fill(pendingAccount);
  await search.press('Enter');
  await page.getByRole('button', { name: '改规则' }).click();
  const ruleDialog = page.getByRole('dialog');
  await expect(ruleDialog).toContainText('这是一条规则，不是一次发放');
  await page.screenshot({ path: evidencePath('billing', '07-rule-dialog.png'), fullPage: true });
  await ruleDialog.getByLabel('每月发放（积分）').fill('600');
  await ruleDialog.getByRole('button', { name: '保存规则' }).click();
  await expect(page.getByText(/规则已保存/)).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', '08-rule-saved.png'), fullPage: true });

  const response = await page.request.post('/api/admin/billing/issue-pending', {
    headers: { origin, cookie: adminCookie },
    data: { userIds: [pendingId], requestId: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const envelope = await response.json() as { data: { issued: number; operationId: string | null } };
  expect(envelope.data).toMatchObject({ issued: 1 });
  expect(envelope.data.operationId).toBeTruthy();

  await page.getByRole('button', { name: '最近操作' }).click();
  const drawer = page.locator('.ant-drawer-section');
  await expect(drawer).toContainText('补发待发');
  await expect(drawer).toContainText('1 成功');
  await page.screenshot({ path: evidencePath('billing', '09-operations.png'), fullPage: true });
});

test('Owner 看到同一份积分；管理员冲正后账单归零、可用回到结算前', async ({ page, browser }) => {
  const account = 'verify_credit_owner_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, account);
  const { appName, generationId } = await seedSettledCharge(ownerId);

  await login(page, account);
  const bar = page.getByRole('region', { name: '我的积分概览' });
  await expect(bar).toContainText('可用');
  await expect(bar).toContainText('40');
  await page.screenshot({ path: evidencePath('billing', '10-owner-bar.png'), fullPage: true });

  await page.goto('/billing');
  const row = page.getByRole('row').filter({ hasText: generationId });
  await expect(row).toContainText(appName);
  await expect(row).toContainText('60 积分');
  await expect(row).toContainText('限时积分 60');
  await page.screenshot({ path: evidencePath('billing', '11-owner-bill.png'), fullPage: true });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await adminLogin(adminPage, 'verify_credit_admin3_' + randomUUID().slice(0, 8));
    await adminPage.goto('/admin/billing');
    await selectUser(adminPage, account);
    await adminPage.getByRole('button', { name: '账单与冲正' }).click();
    const drawer = adminPage.locator('.ant-drawer-section');
    const chargeRow = drawer.getByRole('row').filter({ hasText: generationId });
    await expect(chargeRow).toContainText('60 积分');
    await adminPage.screenshot({ path: evidencePath('billing', '12-before-reverse.png'), fullPage: true });

    await chargeRow.getByRole('button', { name: /^冲\s*正$/ }).click();
    await adminPage.getByLabel('冲正理由').fill('证明：费率配置错误');
    await adminPage.getByRole('button', { name: '确认冲正' }).click();
    await expect(adminPage.getByText('已冲正：反向分录已按原积分种类记入账本')).toBeVisible();
    const reversed = drawer.getByRole('row').filter({ hasText: generationId });
    await expect(reversed).toContainText('已退还');
    await expect(reversed).toContainText('0 积分');
    await adminPage.screenshot({ path: evidencePath('billing', '13-after-reverse.png'), fullPage: true });

    const afterReversal = await ledgerOf(ownerId);
    saveJson('ledger-after-reversal.json', afterReversal);
    expect(afterReversal.rows.map(row => [row.kind, Number(row.credits)])).toEqual([
      ['quota', 100],
      ['consume', -60],
      ['refund', 60],
    ]);
    expect(Number(afterReversal.balance?.available)).toBe(100);
  } finally {
    await adminContext.close();
  }
});
