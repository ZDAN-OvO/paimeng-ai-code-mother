import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * 积分管理（原型 A：主从账本）的浏览器闭环：
 * 左列选人、右列解释余额；发放弹窗写账本；待发/欠款筛选与规则弹窗可用；
 * 批量补发写一条可查的操作日志（用定向 userIds 触发，不扫全库）。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const createdUserIds: string[] = [];
let adminId = '';

async function registerUser(page: Page, account: string): Promise<string> {
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
  adminId = await registerUser(page, account);
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

test.afterAll(async () => {
  if (!createdUserIds.length) return;
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_ledger WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM credit_balance WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM credit_operation WHERE operator_id = $1', [adminId]);
    await connection.query('DELETE FROM credit_quota_policy WHERE created_by = $1', [adminId]);
    await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
  } finally {
    await connection.end();
  }
});

test('主从账本：选人、发放限时积分、流水与统计同步，刷新后仍在', async ({ page }) => {
  const account = 'e2e_credit_' + randomUUID().slice(0, 8);
  const userId = await registerUser(page, account);
  await adminLogin(page, 'e2e_credit_admin_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  await expect(page.getByRole('heading', { name: '积分管理' })).toBeVisible();
  await selectUser(page, account);

  const detail = page.getByRole('region', { name: '用户积分详情' });
  // 注册即得当期 500 限时积分，状态是「已发」。
  await expect(detail).toContainText('500');
  await expect(detail).toContainText('已发');
  await expect(detail).toContainText('每月规则');

  await page.getByRole('button', { name: '发放限时积分' }).click();
  await page.getByLabel('数量（积分）').fill('300');
  await page.getByLabel('理由（写进流水）').fill('浏览器演示：限时补偿');
  await page.getByRole('button', { name: '100' }).click();
  await page.getByLabel('数量（积分）').fill('300');
  await page.getByRole('button', { name: '确认发放' }).click();

  await expect(detail).toContainText('+300');
  await expect(detail).toContainText('浏览器演示：限时补偿');
  await expect(detail).toContainText('800');
  await page.screenshot({ path: evidencePath('billing', 'credit-page-issue.png'), fullPage: true });

  // 刷新后仍是同一个数：回执不是浏览器自己拼的。
  await page.reload();
  await selectUser(page, account);
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('800');
});

test('长期积分与限时积分分开显示，发放长期积分不动到期时间', async ({ page }) => {
  const account = 'e2e_credit_long_' + randomUUID().slice(0, 8);
  const userId = await registerUser(page, account);
  await adminLogin(page, 'e2e_credit_admin2_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  await selectUser(page, account);
  const detail = page.getByRole('region', { name: '用户积分详情' });
  const expiryBefore = await detail.locator('text=到期').locator('..').textContent();

  await page.getByRole('button', { name: '发放长期积分' }).click();
  await page.getByLabel('数量（积分）').fill('200');
  await page.getByLabel('理由（写进流水）').fill('浏览器演示：长期赠送');
  await page.getByRole('button', { name: '确认发放' }).click();

  await expect(detail).toContainText('+200');
  await expect(detail).toContainText('700');
  expect(await detail.locator('text=到期').locator('..').textContent()).toBe(expiryBefore);
  await page.screenshot({ path: evidencePath('billing', 'credit-page-lasting.png'), fullPage: true });
});

test('待发与欠款筛选：统计卡也是入口', async ({ page }) => {
  const pendingAccount = 'e2e_credit_pending_' + randomUUID().slice(0, 8);
  const pendingId = await registerUser(page, pendingAccount);
  const debtAccount = 'e2e_credit_debt_' + randomUUID().slice(0, 8);
  const debtId = await registerUser(page, debtAccount);
  const connection = await testConnection();
  try {
    // 待发：删掉本期规则行；欠款：清空后只留一条负的长期积分。
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1', [pendingId]);
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1', [debtId]);
    await connection.query(
      `INSERT INTO credit_ledger (user_id, kind, origin, credits, create_time)
       VALUES ($1, 'grant', 'manual', -50, timezone('UTC', now())::timestamp(3))`, [debtId],
    );
    await connection.query(
      `INSERT INTO credit_balance (user_id, available, next_expiry_at, update_time)
       VALUES ($1, -50, NULL, timezone('UTC', now())::timestamp(3))
       ON CONFLICT (user_id) DO UPDATE SET available = -50, next_expiry_at = NULL`,
      [debtId],
    );
  } finally {
    await connection.end();
  }
  await adminLogin(page, 'e2e_credit_admin3_' + randomUUID().slice(0, 8));

  await page.goto('/admin/billing');
  const search = page.getByLabel('搜索用户');

  await page.locator('.ant-segmented').getByText('待发', { exact: true }).click();
  await search.fill(pendingAccount);
  await search.press('Enter');
  await expect(page.getByRole('button').filter({ hasText: pendingAccount }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('待发');
  await page.screenshot({ path: evidencePath('billing', 'credit-page-pending.png'), fullPage: true });

  await page.locator('.ant-segmented').getByText('欠款', { exact: true }).click();
  await search.fill(debtAccount);
  await search.press('Enter');
  await expect(page.getByRole('button').filter({ hasText: debtAccount }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText('-50');
  await page.screenshot({ path: evidencePath('billing', 'credit-page-debt.png'), fullPage: true });
});

test('改规则只影响未来账期；定向批量补发写一条可查的操作日志', async ({ page }) => {
  const account = 'e2e_credit_rule_' + randomUUID().slice(0, 8);
  const userId = await registerUser(page, account);
  await adminLogin(page, 'e2e_credit_admin4_' + randomUUID().slice(0, 8));
  const adminCookie = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

  await page.goto('/admin/billing');
  await selectUser(page, account);

  await page.getByRole('button', { name: '改规则' }).click();
  const ruleDialog = page.getByRole('dialog');
  await expect(ruleDialog).toContainText('这是一条规则，不是一次发放');
  await ruleDialog.getByLabel('每月发放（积分）').fill('600');
  await ruleDialog.getByRole('button', { name: '保存规则' }).click();
  await expect(page.getByText(/规则已保存/)).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'credit-page-rule.png'), fullPage: true });

  // 定向补发：先删掉本期规则行，再只对这个人跑一次，产生一条操作日志。
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_ledger WHERE user_id = $1 AND kind = $2', [userId, 'quota']);
  } finally {
    await connection.end();
  }
  const response = await page.request.post('/api/admin/billing/issue-pending', {
    headers: { origin, cookie: adminCookie },
    data: { userIds: [userId], requestId: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const envelope = await response.json() as { code: number; data: { issued: number; operationId: string | null } };
  expect(envelope.data).toMatchObject({ issued: 1 });
  expect(envelope.data.operationId).toBeTruthy();

  await page.getByRole('button', { name: '最近操作' }).click();
  const drawer = page.locator('.ant-drawer-section');
  await expect(drawer).toContainText('补发待发');
  await expect(drawer).toContainText('1 成功');
  await page.screenshot({ path: evidencePath('billing', 'credit-page-operations.png'), fullPage: true });
});
