import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const uniqueAccount = () => 'ts_billing_' + randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

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

async function registerUser(page: Page, account: string): Promise<string> {
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

async function adminLogin(page: Page, account: string) {
  await registerUser(page, account);
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

test.afterAll(async () => {
  if (!createdUserIds.length) return;
  const connection = await testConnection();
  try {
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
  } finally {
    await connection.end();
  }
});

test('管理员发放长期积分后，Owner 的额度条显示长期积分与透支线', async ({ page, browser }) => {
  const ownerAccount = uniqueAccount();
  await registerUser(page, ownerAccount);
  await adminLogin(page, uniqueAccount());

  await page.goto('/admin/billing');
  // 主从账本：左边搜人、选中，右边直接发放。
  await page.getByLabel('搜索用户').fill(ownerAccount);
  await page.getByLabel('搜索用户').press('Enter');
  const ownerRow = page.getByRole('button').filter({ hasText: ownerAccount }).first();
  await expect(ownerRow).toBeVisible();
  await ownerRow.click();
  await expect(page.getByRole('region', { name: '用户积分详情' })).toContainText(ownerAccount);

  await page.getByRole('button', { name: '发放长期积分' }).click();
  await page.getByLabel('数量（积分）').fill('300');
  await page.getByLabel('理由（写进流水）').fill('浏览器演示发放');
  await page.getByRole('button', { name: '确认发放' }).click();

  const detail = page.getByRole('region', { name: '用户积分详情' });
  await expect(detail).toContainText('+300');
  await expect(detail).toContainText('浏览器演示发放');
  await page.screenshot({ path: evidencePath('billing', 'admin-issue.png'), fullPage: true });

  // Owner 换一个浏览器上下文登录：可用额只从自己的 billing/summary 读到。
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    await login(ownerPage, ownerAccount);
    const bar = ownerPage.getByRole('region', { name: '我的积分概览' });
    await expect(bar).toContainText('可用');
    await expect(bar).toContainText('长期');
    await expect(bar).toContainText('300');
    await expect(bar).toContainText('透支线 0 积分');
    await bar.screenshot({ path: evidencePath('billing', 'credit-summary-bar.png') });
    await ownerPage.screenshot({
      path: evidencePath('billing', 'owner-balance.png'),
      fullPage: true,
    });
  } finally {
    await ownerContext.close();
  }
});

test('普通用户不能发放，未登录不显示额度条', async ({ page }) => {
  const account = uniqueAccount();
  const userId = await registerUser(page, account);
  await login(page, account);
  const response = await page.request.post('/api/admin/billing/issue', {
    headers: { origin },
    data: { userId, kind: 'lasting', credits: 100, reason: '越权测试', requestId: randomUUID() },
  });
  expect(response.status()).toBe(403);

  await page.goto('/');
  await expect(page.getByRole('region', { name: '我的积分概览' })).toHaveCount(0);
});
