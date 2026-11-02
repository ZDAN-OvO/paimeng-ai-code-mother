import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { testConnection } from './support/model-config-fixtures';

/**
 * C1 浏览器闭环：菜单改名为额度管理，只保留两个主页签；Credit 管理默认是全用户总览，
 * 搜索用户后从详情抽屉进入额度拆解；补结算只在按需打开的抽屉里出现。
 */

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const createdUserIds: string[] = [];
const run = randomUUID().slice(0, 8);

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

/** 造一个没有 Credit 账户/发放记录的真实用户：注册后删掉当月配额，总览仍必须列出他。 */
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

async function searchFor(page: Page, query: string) {
  const input = page.getByLabel('搜索用户');
  await input.fill(query);
  await input.press('Enter');
}

test.afterAll(async () => {
  if (!createdUserIds.length) return;
  const connection = await testConnection();
  try {
    await connection.query('DELETE FROM credit_account WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM credit_quota_issue WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM credit_grant WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM user_session WHERE user_id = ANY($1::bigint[])', [createdUserIds]);
    await connection.query('DELETE FROM app_user WHERE id = ANY($1::bigint[])', [createdUserIds]);
  } finally {
    await connection.end();
  }
});

test('额度管理只有两个主页签，Credit 管理默认展示全用户总览并可搜索', async ({ page }) => {
  const grantedAccount = `e2e_ov_granted_${run}`;
  const grantedId = await registerUser(page, grantedAccount);
  const pendingAccount = `e2e_ov_pending_${run}`;
  const pendingId = await userWithoutCredit(page, pendingAccount);
  await adminLogin(page, `e2e_ov_admin_${run}`);

  // 菜单与两个主页签：旧的「计费管理」「发放 Credit」「用户用量与冲正」不再作为主页签出现。
  await page.goto('/admin/billing');
  await expect(page.getByRole('menuitem', { name: '额度管理' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '计费管理' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Credit 管理' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '配额管理' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '发放 Credit' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '全用户额度总览' })).toBeVisible();
  await expect(page.getByLabel('当前筛选范围统计')).toBeVisible();

  // 账号模糊搜索：身份三件套都出现在行里，金额由服务端返回。
  await searchFor(page, grantedAccount);
  const grantedRow = page.getByRole('row').filter({ hasText: grantedAccount });
  await expect(grantedRow).toBeVisible();
  await expect(grantedRow).toContainText(grantedId);
  await expect(grantedRow).toContainText('500 Credit');
  await expect(grantedRow).toContainText('已发');
  await page.screenshot({ path: evidencePath('billing', 'admin-overview-search.png'), fullPage: true });

  // 完整 ID 精确搜索：没有 Credit 账户的用户也能被找到，状态是「待发」。
  await searchFor(page, pendingId);
  const pendingRow = page.getByRole('row').filter({ hasText: pendingId });
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow).toContainText(pendingAccount);
  await expect(pendingRow).toContainText('待发');
  await expect(pendingRow).toContainText('0 Credit');
  await page.screenshot({ path: evidencePath('billing', 'admin-overview-pending.png'), fullPage: true });
});

test('从总览打开用户详情，额度拆解、余额发放与账单入口都在抽屉里', async ({ page }) => {
  const account = `e2e_ov_detail_${run}`;
  const userId = await registerUser(page, account);
  await adminLogin(page, `e2e_ov_detail_admin_${run}`);

  await page.goto('/admin/billing');
  await searchFor(page, account);
  const row = page.getByRole('row').filter({ hasText: account });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '查看详情' }).click();

  const drawer = page.locator('.ant-drawer-section');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(account);
  await expect(drawer).toContainText(userId);
  await expect(drawer.getByRole('tab', { name: '额度概览' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: '发放余额' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: '账单与冲正' })).toBeVisible();

  // 额度概览把基础、已用、剩余、余额池分开显示，不用一个合计数字糊过去。
  await expect(drawer).toContainText('基础已发');
  await expect(drawer).toContainText('当前有效剩余');
  await expect(drawer).toContainText('合计可用');
  await expect(drawer).toContainText('余额池');
  await page.screenshot({ path: evidencePath('billing', 'admin-user-detail.png'), fullPage: true });

  // 发放表单从选中用户进入，用户身份固定，不需要再手填用户 ID。
  await drawer.getByRole('tab', { name: '发放余额' }).click();
  await expect(drawer).toContainText('发放对象');
  await expect(drawer).toContainText(account);
  await expect(drawer.getByLabel('发放金额')).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'admin-user-grant.png'), fullPage: true });

  await drawer.locator('.ant-drawer-close').click();
  await expect(drawer).toHaveCount(0);

  // 刷新后仍然是服务端事实，不靠前端缓存。
  await page.reload();
  await searchFor(page, account);
  await expect(page.getByRole('row').filter({ hasText: userId })).toBeVisible();
});

test('配额管理只读展示本月待发，补结算只在 Credit 管理按需打开', async ({ page }) => {
  const account = `e2e_ov_reconcile_${run}`;
  await userWithoutCredit(page, account);
  await adminLogin(page, `e2e_ov_reconcile_admin_${run}`);

  let reconcileListRequests = 0;
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().includes('/api/admin/billing/reconcile')) reconcileListRequests += 1;
  });

  await page.goto('/admin/billing');
  await expect(page.getByRole('heading', { name: '全用户额度总览' })).toBeVisible();
  // 切换页签和浏览总览不触发补结算读请求，更不会触发写操作。
  await page.getByRole('tab', { name: '配额管理' }).click();
  await expect(page.getByRole('heading', { name: '月度配额策略' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本月发放与待发' })).toBeVisible();
  await page.screenshot({ path: evidencePath('billing', 'admin-quota-tab.png'), fullPage: true });
  expect(reconcileListRequests).toBe(0);

  // 回到 Credit 管理，补结算按钮在页签内；打开前没有请求。
  await page.getByRole('tab', { name: 'Credit 管理' }).click();
  await expect(page.getByRole('button', { name: '补结算' })).toBeVisible();
  expect(reconcileListRequests).toBe(0);
  await page.getByRole('button', { name: '补结算' }).click();
  await expect(page.getByRole('heading', { name: '补结算与核对' })).toBeVisible();
  await expect.poll(() => reconcileListRequests).toBeGreaterThan(0);
  await page.screenshot({ path: evidencePath('billing', 'admin-reconcile-drawer.png'), fullPage: true });
  await page.locator('.ant-drawer-close').last().click();
  await expect(page.getByRole('heading', { name: '补结算与核对' })).toHaveCount(0);
});

test('窄屏下总览不撑破页面，表格横向滚动', async ({ page }) => {
  const account = `e2e_ov_narrow_${run}`;
  await registerUser(page, account);
  await adminLogin(page, `e2e_ov_narrow_admin_${run}`);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/admin/billing');
  await expect(page.getByRole('heading', { name: '全用户额度总览' })).toBeVisible();
  await expect(page.getByLabel('搜索用户')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: evidencePath('billing', 'admin-overview-narrow.png'), fullPage: true });
});
