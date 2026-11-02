import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidenceDir, evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * C4 浏览器闭环：Admin 选中一个没有当月发放的用户，预览 500、确认发放、批次完成；
 * 再次预览显示 skipped，不重复发；批次记录与数据库回执一致。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const run = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

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

async function adminLogin(page: Page, account: string): Promise<string> {
  const id = await registerUser(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await login(page, account);
  return id;
}

/** 注册后删掉当月 issue/grant/账户，制造一个真实的「待发」用户。 */
async function userWithoutCredit(page: Page, account: string): Promise<string> {
  const id = await registerUser(page, account);
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_account WHERE user_id = $1', [id]);
    await connection.query('DELETE FROM credit_quota_issue WHERE user_id = $1', [id]);
    await connection.query('DELETE FROM credit_grant WHERE user_id = $1', [id]);
  } finally {
    await connection.end();
  }
  return id;
}

async function selectQuotaUser(page: Page, account: string, userId: string) {
  const picker = page.getByLabel('选择配额策略用户');
  await picker.fill(account);
  await picker.press('Enter');
  await expect(page.getByRole('region', { name: '配额管理' }).getByText(userId, { exact: true }).first()).toBeVisible();
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdUserIds.length) {
      await connection.query(
        'DELETE FROM credit_quota_batch_item WHERE batch_id IN (SELECT id FROM credit_quota_batch WHERE created_by = ANY($1::bigint[]))',
        [createdUserIds],
      );
      await connection.query('DELETE FROM credit_quota_batch WHERE created_by = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_quota_adjustment WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_quota_issue WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_account WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_grant WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
    }
  } finally {
    await connection.end();
  }
});

test('预览选中用户 500、确认发放、批次完成；再次预览只显示 skipped', async ({ page, browser }) => {
  const account = `e2e_batch_user_${run}`;
  const userId = await userWithoutCredit(page, account);
  const adminId = await adminLogin(page, `e2e_batch_admin_${run}`);

  await page.goto('/admin/billing');
  await page.getByRole('tab', { name: '配额管理' }).click();
  await selectQuotaUser(page, account, userId);
  await page.getByRole('button', { name: '预览选中用户' }).click();
  await expect(page.getByText(/已生成预览：1 人待发，合计 500 Credit/)).toBeVisible();
  await expect(page.getByRole('region', { name: '配额管理' }).getByText('待确认').first()).toBeVisible();
  const batchRegion = page.getByRole('region', { name: '配额管理' });
  await expect(batchRegion.getByRole('row').filter({ hasText: userId }).filter({ hasText: '500 Credit' })).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'quota-batch-preview.png'), fullPage: true });

  await page.getByRole('button', { name: '确认发放' }).click();
  await expect(page.getByText(/批次完成：已发 1 人/)).toBeVisible();
  await expect(batchRegion.getByText('已完成').first()).toBeVisible();
  await expect(batchRegion.getByRole('row').filter({ hasText: '当前有效剩余' })).toContainText('500 Credit');
  await page.screenshot({ path: evidencePath('billing', 'quota-batch-completed.png'), fullPage: true });

  // 再次预览同一用户：已发项不再进入待发，只显示 skipped。
  await page.getByRole('button', { name: '预览选中用户' }).click();
  await expect(page.getByText(/已生成预览：0 人待发，合计 0 Credit/)).toBeVisible();
  await expect(batchRegion.getByText('跳过').first()).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'quota-batch-skipped.png'), fullPage: true });

  // Owner 刷新后拿到当月 500。
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    await login(ownerPage, account);
    const bar = ownerPage.getByRole('region', { name: '我的 Credit 概览' });
    await expect(bar).toContainText('500');
    await ownerPage.screenshot({ path: evidencePath('billing', 'quota-batch-owner.png'), fullPage: true });
  } finally {
    await ownerContext.close();
  }

  const connection = await testConnection();
  try {
    const issues = await connection.query('SELECT count(*)::int AS count FROM credit_quota_issue WHERE user_id = $1', [userId]);
    const grants = await connection.query("SELECT count(*)::int AS count FROM credit_grant WHERE user_id = $1 AND source = 'monthly_quota'", [userId]);
    const batches = await connection.query(
      'SELECT status, target_count, granted_count, skipped_count, failed_count FROM credit_quota_batch WHERE created_by = $1 ORDER BY create_time',
      [adminId],
    );
    expect(issues.rows[0].count).toBe(1);
    expect(grants.rows[0].count).toBe(1);
    expect(batches.rows.length).toBeGreaterThanOrEqual(2);
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(evidenceDir('billing'), 'quota-batch-rows.json'), JSON.stringify({
      userId, issues: issues.rows[0].count, grants: grants.rows[0].count, batches: batches.rows,
    }, null, 2) + '\n');
  } finally {
    await connection.end();
  }
});

test('普通用户不能预览/执行批量发放', async ({ page }) => {
  const account = `e2e_batch_plain_${run}`;
  const userId = await registerUser(page, account);
  await login(page, account);
  const preview = await page.request.post('/api/admin/billing/quota/batch/preview', {
    headers: { origin },
    data: { scope: 'users', userIds: [userId] },
  });
  expect(preview.status()).toBe(403);
  const execute = await page.request.post('/api/admin/billing/quota/batch/execute', {
    headers: { origin },
    data: { batchId: 'x', previewToken: 'y' },
  });
  expect(execute.status()).toBe(403);
});
