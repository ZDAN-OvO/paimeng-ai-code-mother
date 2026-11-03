import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../support/test-database-url';
import { appOrigin } from './support/app-origin';
import { evidenceDir } from './support/evidence';

/**
 * App runtime PR-01 的真实链路证据：版本库外置、恢复追加新版本。
 *
 * 走真实 Next + harness + 预览；模型是仓库夹具，夹具把需求文本写进产物 `<h1>`，
 * 所以「预览标题 == 需求」能证明画面来自那一版的内容。
 *
 * 断言：
 * 1. 两轮生成 → 两版；版本库在平台数据根下，应用工作区没有 `.git`；
 * 2. 恢复第一版 → 面板多出第三版（父提交是第二版、内容等于第一版），不是把指针拨回去；
 * 3. 刷新后仍停在恢复版；再次恢复当前版不新增；
 * 4. 下载的源码来自恢复后的版本，且不含第二版内容。
 */

loadEnvFile('.env');

const origin = appOrigin();
const workspaceRoot = process.cwd();
const account = 'verify_versions_' + randomUUID().slice(0, 8);
const password = 'password123';
const firstPrompt = '版本恢复第一版_' + account.slice(-8);
const secondPrompt = '版本恢复第二版_' + account.slice(-8);
const evidence = evidenceDir('app-runtime', 'versions');

let appId = '';
let db: pg.Client;

const appWorkspace = () => join(workspaceRoot, 'runtime/code_output', `html_${appId}`);
const appRepo = () => join(workspaceRoot, 'runtime/versionstore/repos', `html_${appId}.git`);

type Overview = {
  current: { versionId: string } | null;
  versions: { id: string; title: string; changedFiles: string[] }[];
};

async function versions(page: Page): Promise<Overview> {
  const response = await page.request.get('/api/app/versions?appId=' + appId, {
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as Overview;
}

async function waitForVersionCount(page: Page, count: number) {
  await expect
    .poll(async () => (await versions(page)).versions.length, { timeout: 120_000 })
    .toBe(count);
}

async function send(page: Page, text: string) {
  await page.getByLabel('对话消息').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

test.beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  if (appId) {
    await rm(appWorkspace(), { recursive: true, force: true }).catch(() => undefined);
    await rm(appRepo(), { recursive: true, force: true }).catch(() => undefined);
    await db.query('delete from app where id = $1', [appId]).catch(() => undefined);
  }
  await db?.end().catch(() => undefined);
});

test('两版之后恢复第一版：追加新版本、刷新仍在新版、下载读新版源码', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const registered = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: password, checkPassword: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page
    .locator('form')
    .getByRole('button', { name: /^登\s*录$/ })
    .click();
  await expect(page).toHaveURL('/');

  const created = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: firstPrompt, codeGenType: 'html' },
  });
  expect(created.ok()).toBe(true);
  appId = (await created.json()).data as string;
  await page.goto('/app/chat/' + appId);
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();
  await waitForVersionCount(page, 1);
  const preview = page.frameLocator('iframe[title="应用预览"]');
  await expect(preview.getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible();
  const firstVersion = (await versions(page)).versions[0];

  await send(page, secondPrompt);
  await waitForVersionCount(page, 2);
  await expect(page.getByText(/文件已生成/)).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(preview.getByRole('heading', { name: secondPrompt, exact: true })).toBeVisible();
  const secondOverview = await versions(page);
  const secondVersion = secondOverview.versions.find((version) => version.id !== firstVersion.id);
  expect(secondVersion, '第二轮必须产生新版本').toBeTruthy();
  await page.screenshot({ path: join(evidence, '01-two-versions.png'), fullPage: true });

  // PR-01 的文件事实：工作区没有 Git 元数据，历史在平台数据根下。
  await expect
    .poll(
      async () =>
        stat(join(appWorkspace(), '.git')).then(
          () => true,
          () => false,
        ),
      { message: '应用工作区不应再有 .git' },
    )
    .toBe(false);
  expect(
    await stat(join(appRepo(), 'HEAD')).then(
      () => true,
      () => false,
    ),
  ).toBe(true);

  // 恢复第一版：面板最后一行是最早的一版。
  await page.getByRole('button', { name: /^版\s*本$/ }).click();
  const drawer = page.getByRole('dialog', { name: /版本历史/ });
  await expect(drawer).toBeVisible();
  await expect(page.locator('.version-tree-row')).toHaveCount(2);
  await page.screenshot({
    path: join(evidence, '02-version-drawer.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const firstRow = page.locator('.version-tree-row').last();
  await firstRow.getByRole('button', { name: '使用这一版本' }).click();
  await page.getByRole('button', { name: '使用这一版', exact: true }).click();
  await expect(page.getByText(/已换成/)).toBeVisible({ timeout: 90_000 });
  await expect(drawer).toBeHidden({ timeout: 90_000 });

  // 恢复后的画面就是第一版内容，且清单多出一版（历史只增）。
  await expect(preview.getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await waitForVersionCount(page, 3);
  const restored = await versions(page);
  const restoredId = restored.current!.versionId;
  expect(restoredId).not.toBe(firstVersion.id);
  expect(restoredId).not.toBe(secondVersion!.id);
  expect(restored.versions[0].id).toBe(restoredId);
  await page.screenshot({ path: join(evidence, '03-restored.png'), fullPage: true });

  // Git 事实：新版本的父提交是第二版，树等于第一版；HEAD 就在新版本上。
  const gitIn = (args: string[]) =>
    execFileSync('git', ['--git-dir', appRepo(), '--work-tree', appWorkspace(), ...args], {
      encoding: 'utf8',
    }).trim();
  expect(gitIn(['rev-parse', `${restoredId}^`])).toBe(secondVersion!.id);
  expect(gitIn(['rev-parse', `${restoredId}^{tree}`])).toBe(
    gitIn(['rev-parse', `${firstVersion.id}^{tree}`]),
  );
  expect(gitIn(['rev-parse', 'HEAD'])).toBe(restoredId);

  // 刷新后仍显示恢复后的版本，再恢复当前版不新增。
  await page.reload();
  await expect(page.getByText('可预览', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(preview.getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible();
  const afterReload = await versions(page);
  expect(afterReload.current).toEqual({ versionId: restoredId });
  expect(afterReload.versions).toHaveLength(3);
  const repeat = await page.request.post('/api/app/versions/restore', {
    headers: { origin },
    data: { appId, versionId: restoredId },
  });
  expect(repeat.ok()).toBe(true);
  const repeatBody = await repeat.json();
  expect(repeatBody.data.status).toBe('unchanged');
  expect((await versions(page)).versions).toHaveLength(3);

  // 下载读恢复后的源码：包含第一版内容，不含第二版。
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const zipped = execFileSync('unzip', ['-p', downloadPath, 'index.html'], { encoding: 'utf8' });
  expect(zipped).toContain(firstPrompt);
  expect(zipped).not.toContain(secondPrompt);

  // 预览指针必须跟到恢复后的新版本，而不是停在用户点的旧 SHA。
  const rowCounts = await db.query<{
    versions: number;
    running: number;
    pointer_version: string | null;
  }>(
    `select
       (select count(*)::int from version_record where app_id = $1) as versions,
       (select count(*)::int from app_deployment where app_id = $1 and status = 'running') as running,
       (select d.version_sha from app_preview_pointer p
          join generation_delivery d on d.id = p.delivery_id
         where p.app_id = $1) as pointer_version`,
    [appId],
  );
  expect(rowCounts.rows[0]).toEqual({ versions: 3, running: 0, pointer_version: restoredId });

  expect(
    await readFile(join(appWorkspace(), 'index.html'), 'utf8').then((source) =>
      source.includes(firstPrompt),
    ),
  ).toBe(true);

  await writeFile(
    join(evidence, 'version-facts.json'),
    JSON.stringify(
      {
        appId,
        firstVersion: firstVersion.id,
        secondVersion: secondVersion!.id,
        restoredVersion: restoredId,
        versionsAfterRestore: afterReload.versions.length,
        workspaceHasGitDir: await stat(join(appWorkspace(), '.git')).then(
          () => true,
          () => false,
        ),
        repoHead: join('runtime/versionstore/repos', `html_${appId}.git`, 'HEAD'),
        repoLayout: {
          objectsDir: await stat(join(appRepo(), 'objects')).then(
            (info) => info.isDirectory(),
            () => false,
          ),
          durableIndex: await stat(join(appRepo(), 'index')).then(
            () => true,
            () => false,
          ),
          hooksDir: await stat(join(appRepo(), 'hooks')).then(
            () => true,
            () => false,
          ),
          headSha: gitIn(['rev-parse', 'HEAD']),
          refs: gitIn(['for-each-ref', '--format=%(refname)']).split('\n').sort(),
        },
        downloadContainsFirst: zipped.includes(firstPrompt),
        downloadContainsSecond: zipped.includes(secondPrompt),
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  expect(errors).toEqual([]);
});
