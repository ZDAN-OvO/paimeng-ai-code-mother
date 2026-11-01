import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { loadEnvFile } from 'node:process';
import { appOrigin } from './support/app-origin';
import { evidencePath } from './support/evidence';
import { emptyModelConfig, readProviderHeaders, seedModelConfig, testConnection } from './support/model-config-fixtures';

loadEnvFile('.env');

const password = 'password123';
const origin = appOrigin();
const uniqueAccount = () => 'ts_model_' + randomUUID().slice(0, 8);

type AdminConfig = { revision: string; refreshEpoch: string; initialized: boolean };

async function login(page: Page, account: string) {
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
}

async function registerSample(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
}

async function adminLogin(page: Page, account: string) {
  await registerSample(page, account);
  const connection = await testConnection();
  try {
    await connection.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
  } finally {
    await connection.end();
  }
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
}

async function readConfig(page: Page): Promise<AdminConfig> {
  const response = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as AdminConfig;
}

function providerRow(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true }) });
}

function providerRowByBaseUrl(page: Page, baseUrl: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: baseUrl, exact: true }) });
}

// jsonb 不保证键顺序，断言请求头时按名值映射比较，不能依赖行顺序。
async function dialogHeaders(dialog: Locator): Promise<Record<string, string>> {
  const names = await dialog.getByLabel('请求头名称').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const values = await dialog.getByLabel('请求头值').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const headers: Record<string, string> = {};
  names.forEach((name, index) => {
    if (name.trim().length > 0) headers[name.trim()] = values[index] ?? '';
  });
  return headers;
}

async function deleteHeaderRow(dialog: Locator, name: string) {
  const names = await dialog.getByLabel('请求头名称').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`未找到名为 ${name} 的请求头`);
  await dialog.getByLabel('删除请求头').nth(index).click();
}

// 模型分配是四张固定卡片，卡片按槽位中文名定位，不再有别名行。
function slotCard(page: Page, label: string) {
  return page.getByRole('region', { name: `${label}槽位` });
}

function openSlot(page: Page, label: string) {
  return slotCard(page, label).getByRole('button', { name: /^配\s*置$/ }).click();
}

function modelRow(page: Page, upstreamModelName: string) {
  return page.getByRole('row').filter({ has: page.getByText(upstreamModelName, { exact: true }) });
}

async function chooseSelectOption(page: Page, field: Locator, text: string) {
  await field.click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText(text, { exact: false }).first().click();
}

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
  } finally {
    await connection.end();
  }
});

test('未初始化时显示初始化提示，不提供编辑器也不要求密钥', async ({ page }) => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();
  await expect(page.getByText('模型配置尚未初始化', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run db:init-models', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增提供商' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增别名' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '模型分配' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '立即生效', exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  const seed = await testConnection();
  try {
    await seedModelConfig(seed);
  } finally {
    await seed.end();
  }
  await page.getByRole('button', { name: /^刷\s*新$/ }).click();
  await expect(page.getByText('模型配置尚未初始化')).toHaveCount(0);
  await expect(page.getByText('数据库配置版本', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '已配置', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '模型分配' })).toBeVisible();
  await expect(page.getByRole('region', { name: /槽位$/ })).toHaveCount(4);
  await expect(slotCard(page, '代码生成')).toContainText('codegen.default');
  await expect(slotCard(page, '类型路由')).toContainText('route.classify');
  await expect(slotCard(page, '版本标题')).toContainText('未配置');
  await expect(slotCard(page, '语音转写')).toContainText('未配置');
  await expect(page.getByText('必需', { exact: true })).toHaveCount(2);
  await expect(page.getByText('可选', { exact: true })).toHaveCount(2);
});

test('管理员可编辑提供商与槽位分配并普通保存', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.getByRole('menuitem', { name: '模型管理' }).click();
  await expect(page).toHaveURL(/\/admin\/modelManage$/);
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('默认提供商（改）');
  const includeUsage = dialog.getByRole('switch', { name: '统计用量' });
  await expect(includeUsage).toHaveAttribute('aria-checked', 'false');
  await includeUsage.click();
  await expect(includeUsage).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '默认提供商（改）', exact: true })).toBeVisible();

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT options FROM model_provider WHERE id='env-default'");
    const value = (rows as { options: unknown }[])[0]?.options;
    const options = typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : (value as Record<string, unknown>);
    expect(options).toMatchObject({ includeUsage: true });
  } finally {
    await stored.end();
  }

  await page.getByRole('button', { name: '新增提供商' }).click();
  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByLabel('提供商 ID', { exact: true })).toHaveValue('');
  await expect(createDialog.getByLabel('名称', { exact: true })).toHaveValue('');
  await createDialog.getByRole('button', { name: /取\s*消$/ }).click();

  await openSlot(page, '代码生成');
  const aliasDialog = page.getByRole('dialog');
  await expect(aliasDialog).toContainText('codegen.default');
  await expect(aliasDialog.getByText(/\/ test-codegen-model/).first()).toBeVisible();
  await expect(aliasDialog.getByText('工具调用', { exact: true })).toBeVisible();
  await expect(aliasDialog.getByRole('switch', { name: '工具调用' })).toHaveCount(0);
  await aliasDialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('模型分配已保存', { exact: true })).toBeVisible();
  await expect(slotCard(page, '代码生成')).toContainText('test-codegen-model');
});

test('能力与回传思考内容属于提供商模型，槽位只选模型并保留自己的参数', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  // 「回传思考内容」属于模型兼容声明，不再是槽位开关。
  await modelRow(page, 'test-codegen-model').getByRole('button', { name: /^编\s*辑$/ }).click();
  const modelDialog = page.getByRole('dialog');
  const passthrough = modelDialog.getByRole('switch', { name: '模型回传思考内容' });
  await expect(passthrough).toHaveAttribute('aria-checked', 'false');
  await passthrough.click();
  await modelDialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商模型已保存', { exact: true })).toBeVisible();

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT compatibility FROM provider_model WHERE provider_id='env-default' AND upstream_model_name='test-codegen-model'");
    const compatibility = (rows as { compatibility: unknown }[])[0]?.compatibility;
    const value = typeof compatibility === 'string' ? (JSON.parse(compatibility) as Record<string, unknown>) : (compatibility as Record<string, unknown>);
    expect(value).toMatchObject({ reasoningContentPassthrough: true });
  } finally {
    await stored.end();
  }

  // 槽位弹窗不再提供能力/回传开关，只显示模型的能力与费率。
  await openSlot(page, '代码生成');
  const aliasDialog = page.getByRole('dialog');
  await expect(aliasDialog.getByRole('switch', { name: '回传思考内容' })).toHaveCount(0);
  await expect(aliasDialog.getByText('能力与兼容声明由提供商模型决定', { exact: false })).toBeVisible();
  await expect(aliasDialog.getByText('工具调用', { exact: true })).toBeVisible();
  await page.screenshot({ path: evidencePath('provider-model', 'slot-model-readonly.png'), fullPage: true });
  await aliasDialog.getByRole('button', { name: /取\s*消$/ }).click();

  // 可选槽位从已登记模型里选，不能自建上游模型名。
  await expect(slotCard(page, '语音转写')).toContainText('麦克风按钮禁用');
  await openSlot(page, '语音转写');
  const audioDialog = page.getByRole('dialog');
  await chooseSelectOption(page, audioDialog.getByLabel('槽位模型'), 'test-route-model');
  await audioDialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('模型分配已保存', { exact: true }).last()).toBeVisible();
  await expect(slotCard(page, '语音转写')).toContainText('test-route-model');

  await openSlot(page, '语音转写');
  await page.getByRole('dialog').getByRole('button', { name: '清除分配' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByText('已清除语音转写槽位的模型分配', { exact: true })).toBeVisible();
  await expect(slotCard(page, '语音转写')).toContainText('未配置');
});

test('同一请求名在两家提供商下是两条身份，槽位按提供商选择', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
    await connection.query(
      "INSERT INTO model_provider (id, display_name, api_format, base_url, api_key_env, options, enabled, create_time, update_time) VALUES ('env-secondary','第二提供商','openai-chat','https://secondary.example.test/v1','AI_API_KEY','{}',1,timezone('UTC', now()),timezone('UTC', now()))",
    );
    await connection.query(
      `INSERT INTO provider_model (id, provider_id, upstream_model_name, display_name, capabilities, compatibility, enabled, create_time, update_time)
       VALUES ('910000000000000001','env-secondary','test-codegen-model','第二提供商 / test-codegen-model',$1,$2,1,timezone('UTC', now()),timezone('UTC', now()))`,
      [JSON.stringify({ streaming: true, toolCalling: true, structuredOutput: true, imageInput: false }), JSON.stringify({})],
    );
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  await expect(page.getByRole('row').filter({ hasText: 'test-codegen-model' })).toHaveCount(2);
  await expect(page.getByText('env-secondary', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('env-default', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: evidencePath('provider-model', 'same-name-two-providers.png'), fullPage: true });

  await openSlot(page, '代码生成');
  const dialog = page.getByRole('dialog');
  await chooseSelectOption(page, dialog.getByLabel('槽位模型'), '第二提供商 / test-codegen-model');
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('模型分配已保存', { exact: true })).toBeVisible();
  await expect(slotCard(page, '代码生成')).toContainText('第二提供商');
  await expect(slotCard(page, '代码生成')).toContainText('test-codegen-model');

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT provider_id, provider_model_id FROM model_alias WHERE alias='codegen.default'");
    expect(rows[0]).toMatchObject({ provider_id: 'env-secondary', provider_model_id: '910000000000000001' });
  } finally {
    await stored.end();
  }

  await page.setViewportSize({ width: 480, height: 900 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '提供商模型' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: evidencePath('provider-model', 'narrow-480.png'), fullPage: true });
});

test('直接输入的密钥以密文入库，界面与接口都不回显明文', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  const secret = 'sk-inline-e2e-secret';
  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('密钥来源', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('直接输入密钥', { exact: true }).click();
  const keyInput = dialog.getByLabel('密钥', { exact: true });
  await expect(keyInput).toBeVisible();
  await keyInput.fill(secret);
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();

  const stored = await testConnection();
  try {
    const { rows } = await stored.query("SELECT api_key_env, api_key_ciphertext FROM model_provider WHERE id='env-default'");
    const provider = (rows as { api_key_env: string | null; api_key_ciphertext: string | null }[])[0];
    expect(provider?.api_key_env).toBeNull();
    expect(provider?.api_key_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(provider)).not.toContain(secret);
  } finally {
    await stored.end();
  }

  const config = await page.request.post('/api/model/admin/config', { headers: { origin }, data: {} });
  const body = await config.text();
  expect(body).not.toContain(secret);
  expect(body).toContain('"apiKeySource":"inline"');

  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  await expect(page.getByRole('dialog').getByLabel('密钥', { exact: true })).toHaveValue('');
});

test('版本冲突时保留表单输入并可重新加载', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('冲突测试名称');

  const bump = await testConnection();
  try {
    await bump.query("UPDATE model_config_state SET revision = revision + 1 WHERE id='models'");
  } finally {
    await bump.end();
  }

  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('保存失败：模型配置已被其他操作修改', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('冲突测试名称');

  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByText('保存失败：模型配置已被其他操作修改')).toHaveCount(0);
  await dialog.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '冲突测试名称', exact: true })).toBeVisible();
});

test('保存并立即生效与立即生效递增刷新批次', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('cell', { name: 'https://api.example.test/v1', exact: true })).toBeVisible();
  const before = await readConfig(page);

  const row = providerRow(page);
  await row.getByRole('button', { name: /^编\s*辑$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('立即生效提供商');
  await dialog.getByRole('button', { name: /保存并立即生效$/ }).click();
  await expect(page.getByText('提供商已保存并立即生效', { exact: true })).toBeVisible();
  const afterSave = await readConfig(page);
  expect(Number(afterSave.revision)).toBe(Number(before.revision) + 1);
  expect(Number(afterSave.refreshEpoch)).toBe(Number(before.refreshEpoch) + 1);

  await page.getByRole('button', { name: /立即生效$/ }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByText('已请求所有实例立即重新加载模型配置', { exact: true })).toBeVisible();
  const afterApply = await readConfig(page);
  expect(Number(afterApply.revision)).toBe(Number(afterSave.revision));
  expect(Number(afterApply.refreshEpoch)).toBe(Number(afterSave.refreshEpoch) + 1);
});

test('普通用户不能打开模型管理页面', async ({ page }) => {
  const account = uniqueAccount();
  await registerSample(page, account);
  await page.goto('/user/login');
  await login(page, account);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('menuitem', { name: '模型管理' })).toHaveCount(0);
  await page.goto('/admin/modelManage');
  await expect(page).toHaveURL(/\/user\/login\?redirect=/);
});

test('连通性检测与获取模型在界面上给出反馈', async ({ page }) => {
  const connection = await testConnection();
  try {
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await adminLogin(page, uniqueAccount());
  await page.goto('/admin/modelManage');

  await providerRow(page).getByRole('button', { name: /^编\s*辑$/ }).click();
  const providerDialog = page.getByRole('dialog');
  await providerDialog.getByRole('button', { name: '测试连接' }).click();
  await expect(providerDialog.getByText(/无法连接上游/)).toBeVisible({ timeout: 30000 });
  await providerDialog.getByRole('button', { name: /取\s*消$/ }).click();

  await page.getByRole('button', { name: '登记提供商模型' }).click();
  const modelDialog = page.getByRole('dialog');
  await expect(modelDialog.getByLabel('模型提供商', { exact: true })).toBeVisible();
  await modelDialog.getByRole('button', { name: '获取上游候选' }).click();
  await expect(modelDialog.getByText(/无法连接上游/)).toBeVisible({ timeout: 30000 });
  await modelDialog.getByRole('button', { name: /取\s*消$/ }).click();
});

test('从上游候选登记模型并分配给槽位', async ({ page }) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }, { id: 'deepseek-flash' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const connection = await testConnection();
  try {
    await seedModelConfig(connection, upstreamBase);
    await adminLogin(page, uniqueAccount());
    await page.goto('/admin/modelManage');

    await page.getByRole('button', { name: '登记提供商模型' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '获取上游候选' }).click();
    await expect(dialog.getByText(/获取到 2 个上游模型/)).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: evidencePath('provider-model', 'upstream-candidates.png'), fullPage: true });
    await dialog.getByText('mimo-v2.6-flash', { exact: true }).click();
    await expect(dialog.getByLabel('请求模型名', { exact: true })).toHaveValue('mimo-v2.6-flash');
    await dialog.getByRole('switch', { name: '模型能力流式' }).click();
    await dialog.getByRole('switch', { name: '模型能力工具调用' }).click();
    await dialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('提供商模型已保存', { exact: true })).toBeVisible();

    const stored = await testConnection();
    let modelId = '';
    try {
      const { rows } = await stored.query("SELECT id FROM provider_model WHERE provider_id='env-default' AND upstream_model_name='mimo-v2.6-flash'");
      modelId = String((rows as { id: string }[])[0]?.id ?? '');
      expect(modelId).not.toBe('');
    } finally {
      await stored.end();
    }

    await openSlot(page, '代码生成');
    const aliasDialog = page.getByRole('dialog');
    await chooseSelectOption(page, aliasDialog.getByLabel('槽位模型'), 'mimo-v2.6-flash');
    await aliasDialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('模型分配已保存', { exact: true })).toBeVisible();
    await expect(slotCard(page, '代码生成')).toContainText('mimo-v2.6-flash');

    const aliasDb = await testConnection();
    try {
      const { rows } = await aliasDb.query("SELECT provider_model_id FROM model_alias WHERE alias='codegen.default'");
      expect(String((rows as { provider_model_id: string | null }[])[0]?.provider_model_id ?? '')).toBe(modelId);
    } finally {
      await aliasDb.end();
    }
  } finally {
    await connection.end();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('自定义请求头可增删、保存后随探测请求发送', async ({ page }) => {
  const captured: { path: string; userAgent?: string; xTitle?: string }[] = [];
  const upstream = createServer((request, response) => {
    captured.push({
      path: request.url ?? '',
      userAgent: request.headers['user-agent'] as string | undefined,
      xTitle: request.headers['x-title'] as string | undefined,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const connection = await testConnection();
  try {
    await seedModelConfig(connection, upstreamBase);
    await adminLogin(page, uniqueAccount());
    await page.goto('/admin/modelManage');

    const row = providerRowByBaseUrl(page, upstreamBase);
    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头名称').fill('User-Agent');
    await dialog.getByLabel('请求头值').fill('paimeng-ai-code-mother/1.0');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头名称').nth(1).fill('X-Title');
    await dialog.getByLabel('请求头值').nth(1).fill('paimeng');
    await dialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
    // 等第一条提示从 DOM 移除，否则第二次保存时两条同名提示同时存在会触发严格模式冲突。
    await expect(page.getByText('提供商已保存', { exact: true })).toHaveCount(0);

    const stored = await testConnection();
    try {
      expect(await readProviderHeaders(stored)).toEqual({
        'User-Agent': 'paimeng-ai-code-mother/1.0',
        'X-Title': 'paimeng',
      });
    } finally {
      await stored.end();
    }

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const reopened = page.getByRole('dialog');
    await expect
      .poll(() => dialogHeaders(reopened))
      .toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });

    await reopened.getByRole('button', { name: '测试连接' }).click();
    await expect(reopened.getByText(/连接正常/)).toBeVisible({ timeout: 30000 });
    const formProbe = captured.at(-1);
    expect(formProbe?.path).toContain('/models');
    expect(formProbe?.userAgent).toContain('paimeng-ai-code-mother/1.0');
    expect(formProbe?.xTitle).toBe('paimeng');
    await reopened.getByRole('button', { name: /取\s*消$/ }).click();

    await page.getByRole('button', { name: '登记提供商模型' }).click();
    const modelDialog = page.getByRole('dialog');
    await modelDialog.getByRole('button', { name: '获取上游候选' }).click();
    await expect(page.getByText(/获取到 1 个上游模型/)).toBeVisible({ timeout: 30000 });
    const storedProbe = captured.at(-1);
    expect(storedProbe?.userAgent).toContain('paimeng-ai-code-mother/1.0');
    expect(storedProbe?.xTitle).toBe('paimeng');
    await modelDialog.getByRole('button', { name: /取\s*消$/ }).click();

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const editDialog = page.getByRole('dialog');
    await expect.poll(() => dialogHeaders(editDialog)).toEqual({ 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' });
    await deleteHeaderRow(editDialog, 'User-Agent');
    await editDialog.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();

    const afterDelete = await testConnection();
    try {
      expect(await readProviderHeaders(afterDelete)).toEqual({ 'X-Title': 'paimeng' });
    } finally {
      await afterDelete.end();
    }

    await row.getByRole('button', { name: /^编\s*辑$/ }).click();
    const formatDialog = page.getByRole('dialog');
    await formatDialog.getByLabel('API 格式').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText(/OpenAI Responses/).click();
    await expect.poll(() => dialogHeaders(formatDialog)).toEqual({ 'X-Title': 'paimeng' });

    await formatDialog.getByRole('button', { name: /取\s*消$/ }).click();
    await page.getByRole('button', { name: '新增提供商' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByLabel('请求头名称')).toHaveCount(0);
    await createDialog.getByRole('button', { name: /取\s*消$/ }).click();
  } finally {
    await connection.end();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

