#!/usr/bin/env node
/**
 * App runtime 共同探针：在指定 checkout 上跑同一份临时 Playwright spec，收集外部时间。
 *
 * 用法:
 *   node app-runtime-probe.mjs --checkout <绝对路径>/paimeng-ai-code-agent --scenario versions --output <绝对证据目录>
 *
 * 约定：
 *   - 探针本身先复制到树外再运行；本文件不读 checkout 的产品代码，只调用它的 launcher。
 *   - 临时 spec 写入 <checkout>/tests/e2e/app-runtime-probe-run.spec.ts；已存在就停下，
 *     不覆盖别人的文件。文件由本轮创建时，结束时删除，并记录 hash。
 *   - 结果写 <output>/raw-<scenario>-<时间戳>.json 与 <output>/probe-<scenario>.json。
 *   - 这台机器没有可用服务时，命令失败并保留日志，不伪造样本。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCENARIOS = new Set(['generation', 'versions']);

function usage(message) {
  if (message) console.error(message);
  console.error(
    '用法: node app-runtime-probe.mjs --checkout <绝对路径> --scenario <generation|versions> --output <绝对路径>',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) usage(`参数不成对: ${key ?? ''}`);
    args[key.slice(2)] = value;
  }
  for (const name of ['checkout', 'scenario', 'output']) {
    if (!args[name]) usage(`缺参数 --${name}`);
  }
  if (!SCENARIOS.has(args.scenario)) usage(`未知 scenario: ${args.scenario}`);
  return args;
}

const SPEC = String.raw`import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { appOrigin } from './support/app-origin';

const output = process.env.PROBE_OUTPUT as string;
const scenario = process.env.PROBE_SCENARIO ?? 'generation';
const origin = appOrigin();
const suffix = Math.random().toString(36).slice(2, 10);
const account = 'probe_' + suffix;
const password = 'password123';
const firstPrompt = '探针第一版_' + suffix;
const secondPrompt = '探针第二版_' + suffix;

type Sample = { kind: string; ms: number };
const samples: Sample[] = [];
const unsupported: string[] = [];
let appId = '';

const timed = async <T>(kind: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const value = await run();
  samples.push({ kind, ms: Date.now() - started });
  return value;
};

async function versions(page: Page) {
  const response = await page.request.get('/api/app/versions?appId=' + appId, { headers: { origin } });
  if (!response.ok()) throw new Error('versions 接口返回 ' + response.status());
  return (await response.json()).data as {
    current: { versionId: string } | null;
    versions: { id: string; title: string }[];
  };
}

async function waitForVersionCount(page: Page, count: number) {
  await expect.poll(async () => (await versions(page)).versions.length, { timeout: 180_000 }).toBe(count);
}

async function send(page: Page, text: string) {
  await page.getByLabel('对话消息').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

test('app runtime probe', async ({ page }) => {
  test.setTimeout(900_000);
  try {
    const registered = await page.request.post('/api/user/register', {
      headers: { origin },
      data: { userAccount: account, userPassword: password, checkPassword: password },
    });
    if (!registered.ok()) throw new Error('注册失败 ' + registered.status());
    await page.goto('/user/login');
    await page.getByLabel('账号', { exact: true }).fill(account);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
    await expect(page).toHaveURL('/');

    const created = await page.request.post('/api/app/add', {
      headers: { origin },
      data: { initPrompt: firstPrompt, codeGenType: 'html' },
    });
    if (!created.ok()) throw new Error('创建应用失败 ' + created.status());
    appId = (await created.json()).data as string;
    await page.goto('/app/chat/' + appId);

    const preview = page.frameLocator('iframe[title="应用预览"]');
    await timed('generation-first-visible', async () => {
      await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 180_000 });
      await expect(preview.getByRole('heading', { name: firstPrompt, exact: true })).toBeVisible();
    });

    if (scenario === 'versions') {
      if (!(await versions(page).then(() => true, () => false))) {
        unsupported.push('versions-api');
        return;
      }
      await send(page, secondPrompt);
      await waitForVersionCount(page, 2);
      const overview = await versions(page);
      const [newest, oldest] = overview.versions;
      if (!newest || !oldest || newest.id === oldest.id) {
        unsupported.push('two-versions');
        return;
      }

      for (let i = 0; i < 11; i += 1) {
        await timed(i === 0 ? 'versions-list-warmup' : 'versions-list', async () => {
          await versions(page);
        });
      }

      let target = oldest.id;
      for (let i = 0; i < 10; i += 1) {
        const versionId = target;
        await timed(i === 0 ? 'restore-warmup' : 'restore', async () => {
          const response = await page.request.post('/api/app/versions/restore', {
            headers: { origin },
            data: { appId, versionId },
          });
          if (!response.ok()) throw new Error('恢复失败 ' + response.status());
          const body = await response.json();
          if (body?.data?.status !== 'restored') {
            throw new Error('恢复没有追加新版本：' + JSON.stringify(body?.data?.status));
          }
        });
        // 两个原始版本交替恢复，每次都真的追加提交，而不是反复恢复当前版。
        target = versionId === oldest.id ? newest.id : oldest.id;
      }
    }
  } finally {
    writeFileSync(
      output,
      JSON.stringify({ scenario, appId, samples, unsupported, capturedAt: new Date().toISOString() }, null, 2) + '\n',
    );
  }
});
`;

/** 最近秩法 p95：样本少于 2 个时不出分位，避免把单次当分布。 */
function p95(values) {
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkout = resolve(args.checkout);
  const output = resolve(args.output);
  if (!existsSync(join(checkout, 'package.json'))) usage(`不是产品目录: ${checkout}`);
  mkdirSync(output, { recursive: true });

  const specPath = join(checkout, 'tests/e2e/app-runtime-probe-run.spec.ts');
  if (existsSync(specPath)) usage(`临时 spec 已存在，先确认残留来源再删除: ${specPath}`);
  writeFileSync(specPath, SPEC);
  const specHash = createHash('sha256').update(SPEC).digest('hex');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = join(output, `raw-${args.scenario}-${stamp}.json`);
  let exitCode = 0;
  try {
    execFileSync(
      'npm',
      ['run', 'test:e2e:isolated', '--', 'tests/e2e/app-runtime-probe-run.spec.ts'],
      {
        cwd: checkout,
        stdio: 'inherit',
        env: { ...process.env, PROBE_SCENARIO: args.scenario, PROBE_OUTPUT: rawPath },
      },
    );
  } catch (error) {
    exitCode = error?.status ?? 1;
  } finally {
    // 只删本轮新建的这一个文件；上面的存在性检查保证没有覆盖任何已有 spec。
    rmSync(specPath, { force: true });
  }

  if (!existsSync(rawPath)) {
    console.error(`没有样本文件（launcher 或 spec 在写出结果前失败）。退出码 ${exitCode}。`);
    process.exit(exitCode || 1);
  }
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const summary = {
    scenario: raw.scenario,
    checkout,
    spec: { path: 'tests/e2e/app-runtime-probe-run.spec.ts', sha256: specHash },
    samples: raw.samples,
    unsupported: raw.unsupported,
    p95: {
      'generation-first-visible': p95(
        raw.samples.filter((s) => s.kind === 'generation-first-visible').map((s) => s.ms),
      ),
      'versions-list': p95(raw.samples.filter((s) => s.kind === 'versions-list').map((s) => s.ms)),
      restore: p95(raw.samples.filter((s) => s.kind === 'restore').map((s) => s.ms)),
    },
    exitCode,
    capturedAt: new Date().toISOString(),
  };
  const summaryPath = join(output, `probe-${args.scenario}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`样本 ${raw.samples.length} 条 → ${summaryPath}`);
  console.log(JSON.stringify(summary.p95));
  if (exitCode !== 0) process.exit(exitCode);
}

main();
