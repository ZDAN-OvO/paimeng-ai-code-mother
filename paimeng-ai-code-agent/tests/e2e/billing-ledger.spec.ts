import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * Owner 在 /billing 查自己的账单；Admin 在 /admin/billing 里看某个人的账单并整笔冲正。
 * 账单直接落库（结算逻辑在 tests/integration/billing 对真库验证），这里只验证界面能否把
 * 「有效金额 / 扣的是哪种积分 / 冲正状态」表达清楚，以及冲正只退一次。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const createdUserIds: string[] = [];
const createdAppIds: string[] = [];
const createdGenerationIds: string[] = [];

async function register(page: Page, account: string): Promise<string> {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
  const envelope = (await response.json()) as { code: number; data: string };
  expect(envelope.code).toBe(0);
  createdUserIds.push(envelope.data);
  return envelope.data;
}

async function login(page: Page, account: string) {
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page
    .locator('form')
    .getByRole('button', { name: /^登\s*录$/ })
    .click();
  await expect(page).toHaveURL('/');
}

async function adminLogin(page: Page, account: string) {
  await register(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [
      account,
    ]);
  } finally {
    await connection.end();
  }
  await login(page, account);
}

/**
 * 造一个 App + 一笔 60 积分的已结算账单：当期发放 100 → 消费 60 → 可用 40。
 * 冲正之后可用应当回到 100，界面显示「已退还 / 已冲正」。
 */
async function seedSettledCharge(
  ownerId: string,
): Promise<{ appId: string; appName: string; generationId: string }> {
  const appId = String(BigInt(Date.now()) * 100n + BigInt(Math.floor(Math.random() * 100)));
  const generationId = randomUUID();
  createdAppIds.push(appId);
  createdGenerationIds.push(generationId);
  const connection = await testConnection();
  try {
    await connection.query(
      `INSERT INTO app (id, app_name, init_prompt, code_gen_type, user_id, create_time, update_time)
       VALUES ($1, '账单演示应用', '做一个页面', 'html', $2, timezone('UTC', now())::timestamp(3), timezone('UTC', now())::timestamp(3))`,
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
    // 注册时已经发过当期规则行；这里清空重造一个干净账本：100 发放、60 消费、可用 40。
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
       SELECT $1, 'consume', 'charge', -60, $2,
         l.period, l.expires_at, timezone('UTC', now())::timestamp(3)
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
  return { appId, appName: '账单演示应用', generationId };
}

async function availableOf(userId: string): Promise<number> {
  const connection = await testConnection();
  try {
    const { rows } = await connection.query<{ available: string }>(
      'SELECT available FROM credit_balance WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]?.available ?? 0);
  } finally {
    await connection.end();
  }
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdGenerationIds.length) {
      await connection.query('DELETE FROM credit_ledger WHERE charge_id = ANY($1::text[])', [
        createdGenerationIds,
      ]);
      await connection.query('DELETE FROM credit_charge WHERE generation_id = ANY($1::text[])', [
        createdGenerationIds,
      ]);
      await connection.query('DELETE FROM generation WHERE id = ANY($1::text[])', [
        createdGenerationIds,
      ]);
    }
    if (createdAppIds.length)
      await connection.query('DELETE FROM app WHERE id = ANY($1::bigint[])', [createdAppIds]);
    if (createdUserIds.length) {
      await connection.query('DELETE FROM credit_ledger WHERE user_id = ANY($1::bigint[])', [
        createdUserIds,
      ]);
      await connection.query('DELETE FROM credit_balance WHERE user_id = ANY($1::bigint[])', [
        createdUserIds,
      ]);
      await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [
        createdUserIds,
      ]);
      await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
    }
  } finally {
    await connection.end();
  }
});

test('Owner 在 /billing 看到有效金额、积分种类与面额说明', async ({ page }) => {
  const account = 'e2e_ledger_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, account);
  const { appName, generationId } = await seedSettledCharge(ownerId);
  await login(page, account);

  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: '我的账单' })).toBeVisible();
  await expect(page.getByRole('region', { name: '我的积分概览' })).toContainText('限时');

  const row = page.getByRole('row').filter({ hasText: generationId });
  await expect(row).toContainText(appName);
  await expect(row).toContainText('60 积分');
  await expect(row).toContainText('限时积分 60');
  await expect(row).toContainText('已结算');
  await expect(page.getByText('1 积分 = ¥0.01').first()).toBeVisible();
  await expect(page.getByText('不可兑换、不可提现').first()).toBeVisible();

  await page.screenshot({ path: evidencePath('billing', 'owner-ledger-wide.png'), fullPage: true });

  await page.setViewportSize({ width: 480, height: 800 });
  await expect(page.getByLabel('按应用筛选')).toBeVisible();
  await page.screenshot({
    path: evidencePath('billing', 'owner-ledger-narrow.png'),
    fullPage: true,
  });
});

test('Admin 查用户账单并整笔冲正：成本未知可辨识、冲正后只退一次', async ({ page }) => {
  const ownerAccount = 'e2e_ledger_owner_' + randomUUID().slice(0, 8);
  const ownerId = await register(page, ownerAccount);
  const { appName, generationId } = await seedSettledCharge(ownerId);
  await adminLogin(page, 'e2e_ledger_admin_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  await page.getByLabel('搜索用户').fill(ownerAccount);
  await page.getByLabel('搜索用户').press('Enter');
  const ownerRow = page.getByRole('button').filter({ hasText: ownerAccount }).first();
  await expect(ownerRow).toBeVisible();
  await ownerRow.click();
  await page.getByRole('button', { name: '账单与冲正' }).click();

  const drawer = page.locator('.ant-drawer-section');
  const row = drawer.getByRole('row').filter({ hasText: generationId });
  await expect(row).toContainText(appName);
  await expect(row).toContainText('60 积分');
  await expect(row).toContainText('成本未知');
  await expect(row).toContainText('真实用量');

  await row.getByRole('button', { name: /^冲\s*正$/ }).click();
  await page.getByLabel('冲正理由').fill('浏览器演示：费率配置错误');
  await page.getByRole('button', { name: '确认冲正' }).click();
  await expect(page.getByText('已冲正：反向分录已按原积分种类记入账本')).toBeVisible();

  const reversed = drawer.getByRole('row').filter({ hasText: generationId });
  await expect(reversed).toContainText('已退还');
  await expect(reversed).toContainText('0 积分');
  await expect(reversed.getByRole('button', { name: '已冲正' })).toBeDisabled();
  expect(await availableOf(ownerId)).toBe(100);

  await page.screenshot({
    path: evidencePath('billing', 'admin-usage-reversal.png'),
    fullPage: true,
  });
});

test('权限：未登录看不了账单页，普通用户读不到别人的用量', async ({ page }) => {
  await page.goto('/billing');
  await expect(page.getByText('登录后可查看自己的积分与账单')).toBeVisible();

  const account = 'e2e_ledger_plain_' + randomUUID().slice(0, 8);
  const userId = await register(page, account);
  await login(page, account);
  const response = await page.request.get('/api/admin/billing/usage?userId=' + userId, {
    headers: { origin },
  });
  expect(response.status()).toBe(403);
});
