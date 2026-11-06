import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import {
  modelAdminConfigViewSchema,
  type ModelConfigMutation,
} from '../../src/shared/model-document';
import { appOrigin } from './support/app-origin';
import {
  emptyModelConfig,
  grantAdmin,
  readProviderHeaders,
  seedModelConfig,
  testConnection,
} from './support/model-config-fixtures';
import { evidencePath } from './support/evidence';

loadEnvFile('.env');

async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: evidencePath('models', name), fullPage, animations: 'disabled' });
}

function dump(name: string, data: unknown) {
  writeFileSync(evidencePath('models', name), JSON.stringify(data, null, 2) + '\n');
}

const password = 'password123';
const origin = appOrigin();

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

async function register(page: Page, account: string) {
  const response = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(response.ok()).toBe(true);
}

async function readConfig(page: Page) {
  const response = await page.request.post('/api/model/admin/config', {
    headers: { origin },
    data: {},
  });
  expect(response.ok()).toBe(true);
  return modelAdminConfigViewSchema.parse((await response.json()).data);
}

async function mutate(page: Page, mutation: ModelConfigMutation, expectedRevision?: string) {
  const revision = expectedRevision ?? (await readConfig(page)).revision;
  return page.request.post('/api/model/admin/config/mutate', {
    headers: { origin },
    data: { expectedRevision: revision, mutation },
  });
}

function providerGroup(page: Page, id = 'env-default') {
  return page.locator('.ant-collapse-item').filter({ has: page.getByText(id, { exact: true }) });
}

function modelRow(page: Page, name = 'test-codegen-model') {
  return page.getByRole('region', { name: `模型 ${name}`, exact: true });
}

function slotRow(page: Page, slot: string) {
  return page.getByRole('row').filter({ has: page.getByText(slot, { exact: true }) });
}

async function openSlot(page: Page, slot: string) {
  await slotRow(page, slot)
    .getByRole('button', { name: /^配\s*置$/ })
    .click();
  return page.getByRole('dialog');
}

function visibleOptions(page: Page) {
  return page.locator(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
  );
}

async function saveDialog(dialog: Locator) {
  const reloaded = dialog
    .page()
    .waitForResponse(
      (response) =>
        response.url().endsWith('/api/model/admin/config') &&
        response.request().method() === 'POST',
    );
  await dialog.locator('button').filter({ hasText: '保' }).last().click();
  await expect(dialog).not.toBeVisible();
  expect((await reloaded).ok()).toBe(true);
}

async function openManager(page: Page) {
  await page.goto('/admin/modelManage');
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();
  await providerGroup(page).getByText('默认提供商', { exact: true }).click();
  await expect(modelRow(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  const account = 'ts_model_' + randomUUID().slice(0, 8);
  await register(page, account);
  const connection = await testConnection();
  try {
    await grantAdmin(connection, account);
    await seedModelConfig(connection);
  } finally {
    await connection.end();
  }
  await login(page, account);
});

test.afterAll(async () => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
  } finally {
    await connection.end();
  }
});

test('未初始化时提示显式初始化，刷新后显示提供商与四个槽位', async ({ page }) => {
  const connection = await testConnection();
  try {
    await emptyModelConfig(connection);
    await page.goto('/admin/modelManage');
    await expect(page.getByText('模型配置尚未初始化', { exact: true })).toBeVisible();
    await expect(page.getByText('npm run db:init-models', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新增提供商' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '模型分配' })).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    expect((await readConfig(page)).initialized).toBe(false);

    await seedModelConfig(connection);
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await expect(page.getByText('模型配置尚未初始化')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '模型分配' })).toBeVisible();
    await expect(slotRow(page, 'codegen.default')).toContainText('test-codegen-model');
    await expect(slotRow(page, 'route.classify')).toContainText('test-route-model');
    await expect(slotRow(page, 'version.summary')).toContainText('可选未分配');
    await expect(slotRow(page, 'speech.transcribe')).toContainText('可选未分配');
    const config = await readConfig(page);
    expect(config.initialized).toBe(true);
    await shot(page, '01-initialized.png');
    dump('01-initialized-config.json', config);
  } finally {
    await connection.end();
  }
});

test('新增提供商自动展开空模型组，提供添加第一个模型入口', async ({ page }) => {
  await openManager(page);
  await page.getByRole('button', { name: '新增提供商', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('提供商 ID', { exact: true }).fill('e2e-empty');
  await dialog.getByLabel('名称', { exact: true }).fill('空提供商');
  await dialog.getByLabel('地址', { exact: true }).fill('https://empty.example.test/v1');
  await saveDialog(dialog);

  const group = providerGroup(page, 'e2e-empty');
  await expect(group.getByText('还没有配置模型', { exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: '添加第一个模型' })).toBeVisible();
  const emptyConfig = await readConfig(page);
  expect(emptyConfig.providers.find((provider) => provider.id === 'e2e-empty')).toMatchObject({
    displayName: '空提供商',
    models: [],
  });
  await shot(page, '02-empty-provider.png');
  dump('02-empty-provider-config.json', emptyConfig);
  await group.getByRole('button', { name: '添加第一个模型' }).click();
  await expect(page.getByRole('dialog', { name: '在 空提供商 下添加模型' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('上游模型名', { exact: true })).toHaveValue('');
});

test('未定价模型不能分配，Drawer 按人民币追加单价并保留两版历史，旧 Rate card 已移除', async ({
  page,
}) => {
  await openManager(page);
  await expect(page.getByRole('heading', { name: 'Rate card', exact: true })).toHaveCount(0);
  const removedRoute = await page.request.get('/api/admin/billing/rate-card');
  expect(removedRoute.status()).toBe(404);

  await providerGroup(page).getByRole('button', { name: '添加模型', exact: true }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByLabel('上游模型名', { exact: true }).fill('unpriced-model');
  await addDialog.getByLabel('显示名称', { exact: true }).fill('待定价模型');
  await addDialog.getByRole('switch', { name: '流式', exact: true }).click();
  await addDialog.getByRole('switch', { name: '工具调用', exact: true }).click();
  await addDialog.getByRole('button', { name: '添加模型', exact: true }).click();
  await expect(addDialog).not.toBeVisible();
  const row = modelRow(page, '待定价模型');
  await expect(row.getByText('未定价', { exact: true })).toBeVisible();
  await expect(row.getByText('不可分配', { exact: true })).toBeVisible();
  const unpriced = (await readConfig(page)).providers[0].models.find(
    (model) => model.upstream === 'unpriced-model',
  )!;
  expect(unpriced.prices).toEqual([]);
  expect(unpriced.currentPrice).toBeNull();
  await shot(page, '03-unpriced-model.png');
  dump('03-unpriced-config.json', await readConfig(page));

  const slotDialog = await openSlot(page, 'codegen.default');
  await slotDialog.getByLabel('模型', { exact: true }).click();
  await expect(visibleOptions(page).filter({ hasText: 'test-codegen-model' })).toBeVisible();
  await expect(visibleOptions(page).filter({ hasText: '待定价模型' })).toHaveCount(0);
  await expect(visibleOptions(page).filter({ hasText: 'test-route-model' })).toHaveCount(0);
  await page.screenshot({
    path: evidencePath('models', '04-slot-options-exclude-unpriced.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').screenshot({
    path: evidencePath('models', '04b-slot-option-list.png'),
    animations: 'disabled',
  });
  await slotDialog.getByLabel('模型', { exact: true }).press('Escape');
  await slotDialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(slotDialog).not.toBeVisible();

  await row.getByRole('button', { name: /^配\s*置$/ }).click();
  let drawer = page.getByRole('dialog', { name: '配置模型 · 待定价模型' });
  await drawer.getByLabel('输入未命中单价', { exact: true }).fill('6');
  await drawer.getByLabel('输入命中单价', { exact: true }).fill('0.12');
  await drawer.getByLabel('输出单价', { exact: true }).fill('25');
  await saveDialog(drawer);
  await expect(row.getByText('可分配', { exact: true })).toBeVisible();
  await expect(row).toContainText('¥6');
  await expect(row).toContainText('¥0.12');
  await expect(row).toContainText('¥25');
  let priced = (await readConfig(page)).providers[0].models.find(
    (model) => model.id === unpriced.id,
  )!;
  expect(priced.prices).toEqual([
    expect.objectContaining({
      version: 1,
      currency: 'CNY',
      inputMissFen: 600,
      inputHitFen: 12,
      outputFen: 2500,
    }),
  ]);
  await shot(page, '05-priced-model.png');
  dump('05-priced-config.json', await readConfig(page));

  const eligibleDialog = await openSlot(page, 'codegen.default');
  await eligibleDialog.getByLabel('模型', { exact: true }).click();
  await expect(visibleOptions(page).filter({ hasText: '待定价模型' })).toBeVisible();
  await eligibleDialog.getByLabel('模型', { exact: true }).press('Escape');
  await eligibleDialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(eligibleDialog).not.toBeVisible();

  await row.getByRole('button', { name: /^配\s*置$/ }).click();
  drawer = page.getByRole('dialog', { name: '配置模型 · 待定价模型' });
  await drawer.getByLabel('输入未命中单价', { exact: true }).fill('7');
  await saveDialog(drawer);
  await expect(row).toContainText('版本 2');
  priced = (await readConfig(page)).providers[0].models.find((model) => model.id === unpriced.id)!;
  expect(priced.prices).toEqual([
    expect.objectContaining({
      version: 1,
      currency: 'CNY',
      inputMissFen: 600,
      inputHitFen: 12,
      outputFen: 2500,
    }),
    expect.objectContaining({
      version: 2,
      currency: 'CNY',
      inputMissFen: 700,
      inputHitFen: 12,
      outputFen: 2500,
    }),
  ]);
  expect(priced.currentPrice?.version).toBe(2);

  await row.getByRole('button', { name: /^配\s*置$/ }).click();
  drawer = page.getByRole('dialog', { name: '配置模型 · 待定价模型' });
  await expect(drawer.getByRole('heading', { name: '价格版本', exact: true })).toBeVisible();
  const history = drawer.getByRole('table');
  await expect(
    history.getByRole('row').filter({ has: page.getByRole('cell', { name: '1', exact: true }) }),
  ).toContainText('¥6');
  await expect(
    history.getByRole('row').filter({ has: page.getByRole('cell', { name: '2', exact: true }) }),
  ).toContainText('¥7');
  await drawer.getByRole('heading', { name: '价格版本', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, '06-price-history.png');
  dump('06-price-history-config.json', await readConfig(page));
  await drawer.getByRole('button', { name: /^取\s*消$/ }).click();
});

test('必需槽位不能清除，可选槽位能分配与清除，调用参数按槽位保存', async ({ page }) => {
  await openManager(page);
  const requiredDialog = await openSlot(page, 'codegen.default');
  await expect(requiredDialog.getByRole('button', { name: '清除分配' })).toHaveCount(0);
  await requiredDialog.getByRole('switch', { name: '回传思考内容' }).click();
  await saveDialog(requiredDialog);
  await expect(page.getByText('模型分配已保存', { exact: true })).toBeVisible();
  const blocked = await mutate(page, { kind: 'slot.clear', slot: 'codegen.default' });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).message).toContain('必需槽位代码生成（codegen.default）不能清除');
  const requiredConfig = await readConfig(page);
  expect(requiredConfig.assignments.find((item) => item.slot === 'codegen.default')).toMatchObject({
    modelId: 'pm_e2e1',
    settings: { reasoningContentPassthrough: true },
  });
  expect(
    requiredConfig.assignments.find((item) => item.slot === 'route.classify')?.settings,
  ).not.toHaveProperty('reasoningContentPassthrough');

  const optionalDialog = await openSlot(page, 'version.summary');
  await optionalDialog.getByLabel('模型', { exact: true }).click();
  await visibleOptions(page).filter({ hasText: 'test-codegen-model' }).click();
  await saveDialog(optionalDialog);
  await expect(slotRow(page, 'version.summary')).toContainText('test-codegen-model');
  expect(
    (await readConfig(page)).assignments.find((item) => item.slot === 'version.summary')?.modelId,
  ).toBe('pm_e2e1');

  const clearDialog = await openSlot(page, 'version.summary');
  await clearDialog.getByRole('button', { name: '清除分配' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(clearDialog).not.toBeVisible();
  await expect(slotRow(page, 'version.summary')).toContainText('可选未分配');
  const assignmentConfig = await readConfig(page);
  expect(assignmentConfig.assignments.some((item) => item.slot === 'version.summary')).toBe(false);
  await shot(page, '07-assignment-table.png');
  dump('07-assignment-config.json', assignmentConfig);
});

test('停用被引用模型和删除含模型的提供商被阻止并解释引用', async ({ page }) => {
  await openManager(page);
  const before = await readConfig(page);
  const toggle = modelRow(page).getByRole('switch', {
    name: '启用模型 test-codegen-model',
    exact: true,
  });
  await toggle.click();
  await expect(
    page.getByText('模型 test-codegen-model 仍被槽位引用（codegen.default），不能停用', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('保存失败：模型配置已被其他操作修改', { exact: true })).toHaveCount(
    0,
  );
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect((await readConfig(page)).revision).toBe(before.revision);
  await shot(page, '08-reference-guard.png');

  await providerGroup(page)
    .getByRole('button', { name: /^删\s*除$/ })
    .click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(
    page.getByText('提供商 env-default 下还有 2 个模型，不能删除；请先停用提供商或清理模型', {
      exact: true,
    }),
  ).toBeVisible();
  const after = await readConfig(page);
  expect(after.revision).toBe(before.revision);
  expect(after.providers).toEqual(before.providers);
  await expect(modelRow(page, 'test-route-model')).toBeVisible();
});

test('版本冲突保留表单输入，重新加载后可保存', async ({ page }) => {
  await openManager(page);
  await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('冲突测试名称');
  const before = await readConfig(page);
  const concurrent = await mutate(
    page,
    { kind: 'slot.assign', slot: 'version.summary', modelId: 'pm_e2e1', settings: {} },
    before.revision,
  );
  expect(concurrent.ok()).toBe(true);

  await dialog.locator('button').filter({ hasText: '保' }).last().click();
  await expect(
    dialog.getByText('保存失败：模型配置已被其他操作修改', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('冲突测试名称');
  expect((await readConfig(page)).providers[0]?.displayName).toBe('默认提供商');
  await dialog
    .getByText('保存失败：模型配置已被其他操作修改', { exact: true })
    .scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: evidencePath('models', '09-conflict.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(dialog.getByText('保存失败：模型配置已被其他操作修改')).toHaveCount(0);
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('冲突测试名称');
  await saveDialog(dialog);
  await expect(providerGroup(page).getByText('冲突测试名称', { exact: true })).toBeVisible();
  const after = await readConfig(page);
  expect(after.providers[0]?.displayName).toBe('冲突测试名称');
  expect(after.assignments.find((item) => item.slot === 'version.summary')?.modelId).toBe(
    'pm_e2e1',
  );
});

test('直接输入密钥仅以密文持久化，编辑时 DOM 与管理接口不回显', async ({ page }) => {
  await openManager(page);
  const secret = 'sk-inline-e2e-' + randomUUID();
  await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('密钥来源', { exact: true }).click();
  await visibleOptions(page).filter({ hasText: '直接输入密钥' }).click();
  const key = dialog.getByLabel('密钥', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill(secret);
  await saveDialog(dialog);
  await expect(page.getByText('提供商已保存', { exact: true })).toBeVisible();
  const connection = await testConnection();
  try {
    const { rows } = await connection.query<{ apiKey: { source: string; ciphertext: string } }>(
      `SELECT value->'providers'->0->'apiKey' AS "apiKey" FROM app_config WHERE key='model_config'`,
    );
    expect(rows[0]?.apiKey).toMatchObject({
      source: 'inline',
      ciphertext: expect.stringMatching(/^v1:/),
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
  } finally {
    await connection.end();
  }
  const config = await readConfig(page);
  expect(config.providers[0]).toMatchObject({ apiKeySource: 'inline', apiKeyConfigured: true });
  const response = await page.request.post('/api/model/admin/config', {
    headers: { origin },
    data: {},
  });
  const body = await response.text();
  expect(body).not.toContain(secret);
  expect(body).not.toContain('ciphertext');
  expect(body).not.toContain('v1:');

  await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByLabel('密钥', { exact: true })).toHaveValue('');
  await expect(reopened.getByLabel('密钥', { exact: true })).toHaveAttribute('type', 'password');
  await shot(page, '10-secret-masked.png');
  expect(await page.content()).not.toContain(secret);
  expect(
    await page
      .locator('input')
      .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
  ).not.toContain(secret);
  await reopened.getByLabel('名称', { exact: true }).fill('密钥保持提供商');
  await saveDialog(reopened);
  expect((await readConfig(page)).providers[0]).toMatchObject({
    displayName: '密钥保持提供商',
    apiKeyConfigured: true,
  });
});

test('480px 视口下提供商、模型抽屉和槽位表单不产生页面横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await openManager(page);
  async function expectNoPageOverflow() {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await expect(slotRow(page, 'codegen.default')).toBeVisible();
  await expectNoPageOverflow();
  await modelRow(page)
    .getByRole('button', { name: /^配\s*置$/ })
    .click();
  const drawer = page.getByRole('dialog', { name: '配置模型 · test-codegen-model' });
  await expect(drawer.getByLabel('输入未命中单价', { exact: true })).toBeVisible();
  await expectNoPageOverflow();
  await shot(page, '11-narrow-480-drawer.png');
  await drawer.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(drawer).not.toBeVisible();
  const dialog = await openSlot(page, 'version.summary');
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
  await expectNoPageOverflow();
  await shot(page, '12-narrow-480-slot.png');
});

test('提供商探测反馈、上游模型选择和自定义请求头通过真实本机上游验证', async ({ page }) => {
  const captured: { path: string; title: string | string[] | undefined }[] = [];
  let failProbe = false;
  const upstream = createServer((request, response) => {
    captured.push({ path: request.url ?? '', title: request.headers['x-title'] });
    response.writeHead(failProbe ? 503 : 200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        failProbe
          ? { error: { message: 'fixture unavailable' } }
          : { data: [{ id: 'mimo-v2.6-flash' }] },
      ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const connection = await testConnection();
  try {
    await seedModelConfig(
      connection,
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    );
    await openManager(page);
    await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '添加请求头' }).click();
    await dialog.getByLabel('请求头名称', { exact: true }).fill('X-Title');
    await dialog.getByLabel('请求头值', { exact: true }).fill('paimeng-e2e');
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(
      dialog.getByText('连接正常，共 1 个模型：mimo-v2.6-flash', { exact: true }),
    ).toBeVisible();
    expect(captured.at(-1)).toEqual({ path: '/v1/models', title: 'paimeng-e2e' });
    await saveDialog(dialog);
    expect(await readProviderHeaders(connection)).toEqual({ 'X-Title': 'paimeng-e2e' });

    await providerGroup(page).getByRole('button', { name: '添加模型', exact: true }).click();
    const addDialog = page.getByRole('dialog');
    await addDialog.getByRole('button', { name: '获取上游模型', exact: true }).click();
    await expect(addDialog.getByText('已获取 1 个上游模型', { exact: true })).toBeVisible();
    expect(captured.at(-1)).toEqual({ path: '/v1/models', title: 'paimeng-e2e' });
    const upstreamName = addDialog.getByLabel('上游模型名', { exact: true });
    await upstreamName.fill('mimo');
    await visibleOptions(page).filter({ hasText: 'mimo-v2.6-flash' }).click();
    await expect(upstreamName).toHaveValue('mimo-v2.6-flash');
    await addDialog.getByLabel('显示名称', { exact: true }).fill('上游选择模型');
    await addDialog.getByRole('button', { name: '添加模型', exact: true }).click();
    await expect(addDialog).not.toBeVisible();
    await expect(modelRow(page, '上游选择模型')).toBeVisible();
    expect(
      (await readConfig(page)).providers[0]?.models.find(
        (model) => model.displayName === '上游选择模型',
      )?.upstream,
    ).toBe('mimo-v2.6-flash');

    failProbe = true;
    await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
    const failedDialog = page.getByRole('dialog');
    await failedDialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(failedDialog.getByText(/503/)).toBeVisible();
    await expect(failedDialog.getByLabel('请求头值', { exact: true })).toHaveValue('paimeng-e2e');
  } finally {
    await connection.end();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('普通用户不能进入模型管理', async ({ page }) => {
  await page.request.post('/api/user/logout', { headers: { origin }, data: {} });
  const account = 'ts_model_user_' + randomUUID().slice(0, 8);
  await register(page, account);
  await login(page, account);
  await expect(page.getByRole('menuitem', { name: '模型管理' })).toHaveCount(0);
  await page.goto('/admin/modelManage');
  await expect(page).toHaveURL(/\/user\/login\?redirect=/);
});

test('编辑提供商与模型时回填当前配置', async ({ page }) => {
  const consoleWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
  await openManager(page);
  await providerGroup(page).getByRole('button', { name: '编辑提供商', exact: true }).click();
  const providerDialog = page.getByRole('dialog', { name: '编辑提供商' });
  await expect(providerDialog.getByLabel('提供商 ID', { exact: true })).toHaveValue('env-default');
  await expect(providerDialog.getByLabel('名称', { exact: true })).toHaveValue('默认提供商');
  await expect(providerDialog.getByLabel('地址', { exact: true })).toHaveValue(
    'https://api.example.test/v1',
  );
  await providerDialog.screenshot({
    path: evidencePath('models', '13-edit-provider-prefilled.png'),
    animations: 'disabled',
  });
  await providerDialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(providerDialog).not.toBeVisible();

  await modelRow(page)
    .getByRole('button', { name: /^配\s*置$/ })
    .click();
  const drawer = page.getByRole('dialog', { name: '配置模型 · test-codegen-model' });
  await expect(drawer.getByLabel('显示名称', { exact: true })).toHaveValue('test-codegen-model');
  await expect(drawer.getByLabel('输入未命中单价', { exact: true })).toHaveValue('6.00');
  await expect(drawer.getByLabel('输入命中单价', { exact: true })).toHaveValue('0.12');
  await expect(drawer.getByLabel('输出单价', { exact: true })).toHaveValue('25.00');
  await drawer.screenshot({
    path: evidencePath('models', '14-edit-model-prefilled.png'),
    animations: 'disabled',
  });
  expect(consoleWarnings.filter((warning) => warning.includes('[antd: Drawer]'))).toEqual([]);
});
