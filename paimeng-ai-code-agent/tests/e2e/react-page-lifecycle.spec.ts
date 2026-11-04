import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { grantAdmin, testConnection } from './support/model-config-fixtures';

/**
 * 普通页面与会话的数据作用域：退出登录不留下上个账号的作品，管理员不因键入自动查询，
 * 编辑页旧应用的迟到响应不能覆盖新应用。断言读取本次唯一账号，截图落进证据目录。
 */

const password = 'password123';
const origin = appOrigin();

async function register(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok(), `register ${account}`).toBe(true);
  return (await response.json()).data as string;
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

async function createApp(page: Page, prompt: string) {
  const response = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: prompt, codeGenType: 'html' },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).data as string;
  const named = await page.request.post('/api/app/update', {
    headers: { origin },
    data: { id, appName: prompt },
  });
  expect(named.ok()).toBe(true);
  return id;
}

async function logout(page: Page) {
  await page.locator('.site-header').getByRole('button').last().click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/user\/login/);
}

test('退出登录后不再显示上个账号的作品，换账号只显示自己的', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const first = 'lifecycle_a_' + suffix;
  const second = 'lifecycle_b_' + suffix;
  const firstApp = '甲账号作品_' + suffix;
  const secondApp = '乙账号作品_' + suffix;

  await register(page, first);
  await login(page, first);
  await createApp(page, firstApp);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: firstApp, exact: true })).toBeVisible();
  await page.screenshot({
    path: evidencePath('react-lint', '01-first-account-home.png'),
    fullPage: true,
  });

  await logout(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: firstApp, exact: true })).toHaveCount(0);
  await page.screenshot({
    path: evidencePath('react-lint', '02-logged-out-home.png'),
    fullPage: true,
  });

  await register(page, second);
  await login(page, second);
  await createApp(page, secondApp);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: secondApp, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: firstApp, exact: true })).toHaveCount(0);
  await page.screenshot({
    path: evidencePath('react-lint', '03-second-account-home.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: secondApp, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: firstApp, exact: true })).toHaveCount(0);

  writeFileSync(
    evidencePath('react-lint', 'page-lifecycle.json'),
    JSON.stringify({ first, second, firstApp, secondApp }, null, 2) + '\n',
  );
});

test('第一次保存后的刷新读迟到时，不会把新名称改回旧名称', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const account = 'lifecycle_edit_' + suffix;
  await register(page, account);
  await login(page, account);
  const originalName = '初始名称_' + suffix;
  const firstSave = '第一次保存_' + suffix;
  const secondSave = '第二次保存_' + suffix;
  const appId = await createApp(page, originalName);

  // 第一次保存后的刷新读先在服务端取回当时的旧名称并扣住，等第二次保存的刷新读落地后才交出去。
  // 不用固定等待：扣住的是真实响应，放行时机由下面的 releaseStaleRead 决定。
  let reads = 0;
  let held = false;
  let releaseStaleRead = () => {};
  const staleReadHeld = new Promise<void>((resolve) => {
    releaseStaleRead = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/app/get/vo' && url.searchParams.get('id') === appId,
    async (route) => {
      reads += 1;
      if (reads !== 2) {
        await route.continue();
        return;
      }
      const stale = await route.fetch();
      held = true;
      await staleReadHeld;
      await route.fulfill({ response: stale });
    },
  );

  await page.goto('/app/edit/' + appId);
  await expect(page.getByLabel('应用名称', { exact: true })).toHaveValue(originalName);

  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/app/update') && response.request().method() === 'POST',
    );
  const refreshed = () =>
    page.waitForResponse((response) => response.url().includes('/api/app/get/vo?id=' + appId));

  await page.getByLabel('应用名称', { exact: true }).fill(firstSave);
  const firstSaved = saved();
  await page.getByRole('button', { name: '保存修改' }).click();
  expect((await firstSaved).ok()).toBe(true);
  await expect.poll(() => held, { timeout: 10_000 }).toBe(true);

  await page.getByLabel('应用名称', { exact: true }).fill(secondSave);
  const secondSaved = saved();
  const secondRefreshed = refreshed();
  await page.getByLabel('应用名称', { exact: true }).press('Enter');
  expect((await secondSaved).ok()).toBe(true);
  await secondRefreshed;

  releaseStaleRead();
  await expect(page.getByLabel('应用名称', { exact: true })).toHaveValue(secondSave);
  const stored = (await (await page.request.get('/api/app/get/vo?id=' + appId)).json()).data;
  expect(stored.appName).toBe(secondSave);
  await page.screenshot({
    path: evidencePath('react-lint', '06-stale-read-ignored.png'),
    fullPage: true,
  });

  writeFileSync(
    evidencePath('react-lint', 'stale-read.json'),
    JSON.stringify(
      { appId, originalName, firstSave, secondSave, shown: secondSave, stored: stored.appName },
      null,
      2,
    ) + '\n',
  );
});

test('管理员键入筛选词但不提交时不会发查询，提交后才查', async ({ page }) => {
  const account = 'lifecycle_admin_' + randomUUID().slice(0, 8);
  await register(page, account);
  const connection = await testConnection();
  try {
    await grantAdmin(connection, account);
  } finally {
    await connection.end();
  }

  let queries = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/user/list/page/vo')) queries += 1;
  });

  await login(page, account);
  await page.goto('/admin/userManage');
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  await expect.poll(() => queries).toBe(1);

  const search = page.getByLabel('搜索账号');
  await search.fill('typed_' + randomUUID().slice(0, 6));
  await page.waitForTimeout(600);
  expect(queries, '键入不应自动提交查询').toBe(1);
  await page.screenshot({ path: evidencePath('react-lint', '04-admin-typed.png'), fullPage: true });

  await page.getByRole('button', { name: /^搜\s*索$/ }).click();
  await expect.poll(() => queries).toBe(2);
  await page.screenshot({
    path: evidencePath('react-lint', '05-admin-submitted.png'),
    fullPage: true,
  });

  writeFileSync(
    evidencePath('react-lint', 'admin-search.json'),
    JSON.stringify({ account, queriesAfterTyping: 1, queriesAfterSubmit: queries }, null, 2) + '\n',
  );
});
