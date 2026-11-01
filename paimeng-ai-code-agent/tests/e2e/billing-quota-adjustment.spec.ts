import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidenceDir, evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * C3 浏览器闭环：Admin 在「配额管理」对选中用户增加当月剩余、设为目标剩余，扣回超额被拒绝；
 * 刷新、Owner 额度条与数据库调整行三处一致。
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

async function selectQuotaUser(page: Page, account: string, userId: string) {
  const picker = page.getByLabel('选择配额策略用户');
  await picker.fill(account);
  await picker.press('Enter');
  await expect(page.getByRole('region', { name: '配额管理' }).getByText(userId, { exact: true }).first()).toBeVisible();
}

async function expectRemaining(page: Page, credits: number) {
  const row = page.getByRole('region', { name: '配额管理' })
    .getByRole('row').filter({ hasText: '当前有效剩余' });
  await expect(row).toContainText(`${credits} Credit`);
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    if (createdUserIds.length) {
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

test('增加 100、目标 350 与超额扣回：确认弹窗展示前后值，刷新后仍一致', async ({ page, browser }) => {
  const account = `e2e_adjust_user_${run}`;
  const userId = await registerUser(page, account);
  await adminLogin(page, `e2e_adjust_admin_${run}`);

  await page.goto('/admin/billing');
  await page.getByRole('tab', { name: '配额管理' }).click();
  await selectQuotaUser(page, account, userId);
  await expectRemaining(page, 500);
  await page.screenshot({ path: evidencePath('billing', 'quota-adjust-before.png'), fullPage: true });

  // 增加 100：表单只负责收集意图，弹窗展示身份、前后值与到期时间，确认后才写。
  await page.getByLabel('调整金额').fill('100');
  await page.getByLabel('调整理由').fill('E2E：投诉补偿');
  await page.getByRole('button', { name: '确认调整' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('确认调整当月配额');
  await expect(confirm).toContainText(account);
  await expect(confirm).toContainText(userId);
  await expect(confirm).toContainText('500 Credit');
  await expect(confirm).toContainText('100 Credit');
  await expect(confirm).toContainText('600 Credit');
  await page.screenshot({ path: evidencePath('billing', 'quota-adjust-confirm.png'), fullPage: true });
  await confirm.getByRole('button', { name: '确认调整' }).click();
  await expect(page.getByText(/已调整：500 → 600 Credit/)).toBeVisible();
  await expectRemaining(page, 600);
  await page.screenshot({ path: evidencePath('billing', 'quota-adjust-increased.png'), fullPage: true });

  // 设为目标剩余 350：服务端在锁内计算差额 -250，客户端不自己算后提交。
  await page.getByLabel('调整方式').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('设为目标剩余').click();
  await page.getByLabel('调整金额').fill('350');
  await page.getByLabel('调整理由').fill('E2E：统一到 350');
  await page.getByRole('button', { name: '确认调整' }).click();
  const targetConfirm = page.getByRole('dialog');
  await expect(targetConfirm).toContainText('调整差额');
  await expect(targetConfirm).toContainText('-250 Credit');
  await targetConfirm.getByRole('button', { name: '确认调整' }).click();
  await expect(page.getByText(/已调整：600 → 350 Credit/)).toBeVisible();
  await expectRemaining(page, 350);

  // 刷新后重新选中用户，剩余仍为服务端事实。
  await page.reload();
  await page.getByRole('tab', { name: '配额管理' }).click();
  await selectQuotaUser(page, account, userId);
  await expectRemaining(page, 350);

  // 超额扣回：界面先报错，不打开确认弹窗；数据库不新增调整行。
  await page.getByLabel('调整方式').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('扣回当月剩余').click();
  await page.getByLabel('调整金额').fill('9999');
  await page.getByLabel('调整理由').fill('E2E：超额扣回');
  await page.getByRole('button', { name: '确认调整' }).click();
  await expect(page.getByText(/不能超过当前有效剩余 350/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: evidencePath('billing', 'quota-adjust-overdraw.png'), fullPage: true });

  // Owner 额度条读同一份事实。
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    await login(ownerPage, account);
    const bar = ownerPage.getByRole('region', { name: '我的 Credit 概览' });
    await expect(bar).toContainText('350');
    await ownerPage.screenshot({ path: evidencePath('billing', 'quota-adjust-owner.png'), fullPage: true });
  } finally {
    await ownerContext.close();
  }

  const connection = await testConnection();
  try {
    const { rows } = await connection.query<{ mode: string; credits: string; before_credits: string; after_credits: string; reason: string }>(
      'SELECT mode, credits, before_credits, after_credits, reason FROM credit_quota_adjustment WHERE user_id = $1 ORDER BY before_credits',
      [userId],
    );
    expect(rows).toEqual([
      { mode: 'increase', credits: '100', before_credits: '500', after_credits: '600', reason: 'E2E：投诉补偿' },
      { mode: 'target', credits: '-250', before_credits: '600', after_credits: '350', reason: 'E2E：统一到 350' },
    ]);
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(evidenceDir('billing'), 'quota-adjust-rows.json'), JSON.stringify({ userId, rows }, null, 2) + '\n');
  } finally {
    await connection.end();
  }
});

test('普通用户不能调用调整接口', async ({ page }) => {
  const account = `e2e_adjust_plain_${run}`;
  const userId = await registerUser(page, account);
  await login(page, account);
  const response = await page.request.post('/api/admin/billing/quota/adjust', {
    headers: { origin },
    data: { userId, mode: 'increase', amount: 1, reason: '越权', requestId: 'e2e-adjust-denied' },
  });
  expect(response.status()).toBe(403);
});
