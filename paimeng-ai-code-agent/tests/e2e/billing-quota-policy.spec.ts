import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidenceDir, evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * C2 浏览器闭环：Admin 在「配额管理」保存未来全局策略与单用户覆盖/继承。
 * 当前账期不变；策略版本保留；0 覆盖与继承在界面上可区分。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const run = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const notes: string[] = [];

function nextPeriod(): string {
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = beijing.getUTCMonth() + 1;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

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
  await registerUser(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await login(page, account);
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdUserIds.length) {
      await connection.query('DELETE FROM credit_quota_policy WHERE created_by = ANY($1::bigint[])', [createdUserIds]);
      await connection.query('DELETE FROM credit_quota_policy WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
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

test('保存未来全局策略：下一账期显示 700，当前账期仍是 500', async ({ page }) => {
  const targetPeriod = nextPeriod();
  await adminLogin(page, `e2e_quota_admin_${run}`);
  await page.goto('/admin/billing');
  await page.getByRole('tab', { name: '配额管理' }).click();
  await expect(page.getByRole('heading', { name: '月度配额策略' })).toBeVisible();
  await expect(page.getByRole('region', { name: '配额管理' }).getByText('500 Credit（系统默认）').first()).toBeVisible();

  await page.getByLabel('全局生效账期').fill(targetPeriod);
  await page.getByLabel('全局每月基础配额').fill('700');
  await page.getByLabel('全局策略备注').fill(`E2E 全局 ${run}`);
  await page.getByRole('button', { name: '保存全局策略' }).click();
  await expect(page.getByText(`已保存全局策略 v1，${targetPeriod} 起生效`)).toBeVisible();

  const globalRow = page.getByRole('row').filter({ hasText: targetPeriod }).filter({ hasText: '700 Credit' }).filter({ hasText: 'v1' });
  await expect(globalRow).toBeVisible();
  // 当前账期仍显示系统默认 500；策略只改未来。
  await expect(page.getByRole('region', { name: '配额管理' }).getByText('500 Credit（系统默认）').first()).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'quota-policy-global.png'), fullPage: true });
});

test('单用户覆盖 0 与继承全局在界面上是两种事实', async ({ page }) => {
  const targetPeriod = nextPeriod();
  const userAccount = `e2e_quota_user_${run}`;
  const userId = await registerUser(page, userAccount);
  await adminLogin(page, `e2e_quota_user_admin_${run}`);

  await page.goto('/admin/billing');
  await page.getByRole('tab', { name: '配额管理' }).click();
  const picker = page.getByLabel('选择配额策略用户');
  await picker.fill(userAccount);
  await picker.press('Enter');
  await expect(page.getByRole('region', { name: '配额管理' }).getByText(userId, { exact: true }).first()).toBeVisible();

  await page.getByLabel('用户生效账期').fill(targetPeriod);
  await page.getByLabel('用户规则').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('覆盖金额').click();
  await page.getByLabel('用户每月基础配额').fill('0');
  await page.getByLabel('用户策略备注').fill(`E2E 零配额 ${run}`);
  await page.getByRole('button', { name: '保存用户策略' }).click();
  await expect(page.getByText(/已保存用户策略 v1；0 Credit（用户覆盖）/)).toBeVisible();
  await expect(page.getByText('0 Credit（用户覆盖 · v1）')).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'quota-policy-user-zero.png'), fullPage: true });

  // 同一账期保存 inherit：版本 v2，下一账期重新回落到全局默认 500。
  await page.getByLabel('用户规则').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('继承全局默认').click();
  await page.getByLabel('用户策略备注').fill(`E2E 继承 ${run}`);
  await page.getByRole('button', { name: '保存用户策略' }).click();
  await expect(page.getByText(/已保存用户策略 v2；\d+ Credit（(?:全局默认|系统默认)）/)).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'quota-policy-user-inherit.png'), fullPage: true });

  const connection = await testConnection();
  try {
    const { rows } = await connection.query<{ mode: string; credits: string | null; revision: number; note: string | null }>(
      'SELECT mode, credits, revision, note FROM credit_quota_policy WHERE user_id = $1 ORDER BY revision',
      [userId],
    );
    expect(rows).toEqual([
      { mode: 'override', credits: '0', revision: 1, note: `E2E 零配额 ${run}` },
      { mode: 'inherit', credits: null, revision: 2, note: `E2E 继承 ${run}` },
    ]);
    // 策略只写版本，不发钱；下一账期 issue 要等发放入口/批量执行才出现。
    const issues = await connection.query('SELECT count(*)::int AS count FROM credit_quota_issue WHERE user_id = $1 AND period = $2', [userId, targetPeriod]);
    expect(issues.rows[0].count).toBe(0);
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(evidenceDir('billing'), 'quota-policy-rows.json'), JSON.stringify({ userId, targetPeriod, rows }, null, 2) + '\n');
  } finally {
    await connection.end();
  }
});

test('普通用户不能读取或保存配额策略', async ({ page }) => {
  const account = `e2e_quota_plain_${run}`;
  await registerUser(page, account);
  await login(page, account);
  const read = await page.request.get('/api/admin/billing/quota/policy', { headers: { origin } });
  expect(read.status()).toBe(403);
  const write = await page.request.post('/api/admin/billing/quota/policy', {
    headers: { origin },
    data: { scope: 'global', effectivePeriod: nextPeriod(), mode: 'override', credits: 1, expectedRevision: null },
  });
  expect(write.status()).toBe(403);
});
