import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, users } from '@/server/infra/schema';
import { initializeTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate } from '@/server/templates/templates';
import { ensureRuntime, ensureSafeDirectory, workspace } from '@/server/workspace/workspace';
import { getConfig } from '@/server/infra/config';
import { ensureAppRuntime, stopAppRuntime } from '@/server/app-runtime/supervisor';
import { runRuntimeShell } from '@/server/app-runtime/shell';
import { runtimeContainerName } from '@/server/app-runtime/plan';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 真实 Docker：shell 工具的执行器。断言外部可观察的结果——
 * 命令在 /work 执行、宿主能读到容器写出的文件、平台变量不在容器里、超时/取消后没有命令继续改源码。
 */

const template = resolveTemplate('react-ts', '2.0.0');
const appsUnderTest = [
  { id: '', codeGenType: 'react_project' as const },
  { id: '', codeGenType: 'react_project' as const },
];
let userId: bigint;
const probe = '.paimeng-timeout-probe';

beforeAll(async () => {
  userId = await nextSnowflakeId();
  await db().insert(users).values({ id: userId, userAccount: 'ts_app_shell_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
  for (const app of appsUnderTest) {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: 'App shell system', codeGenType: app.codeGenType, userId, createTime: now(), updateTime: now() });
    app.id = id.toString();
    await ensureSafeDirectory(join(await ensureRuntime(), 'code_output'));
    await initializeTemplate(app, template);
  }
}, 180_000);

afterAll(async () => {
  for (const app of appsUnderTest) {
    if (!app.id) continue;
    await stopAppRuntime(app).catch(() => undefined);
    await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
    await db().delete(apps).where(eq(apps.id, BigInt(app.id))).catch(() => undefined);
  }
  if (userId) await db().delete(users).where(eq(users.id, userId)).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

describe('真实 Docker 上的 shell 执行器', () => {
  it('在 App 自己的 Workspace 里执行，宿主能读到容器写出的文件', async () => {
    const app = appsUnderTest[0];
    expect((await ensureAppRuntime({ app, workspaceRoot: workspace(app) })).status).toBe('ready');
    const marker = `shell-pwd-${randomUUID().slice(0, 8)}`;
    const result = await runRuntimeShell({ app, command: `pwd; printf "${marker}" > shell-write.txt` });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('/work');
    expect(await readFile(join(workspace(app), 'shell-write.txt'), 'utf8')).toBe(marker);
    expect((await stat(join(workspace(app), 'shell-write.txt'))).uid).toBe(process.getuid?.() ?? 1000);
    // 容器里没有 .git：版本历史在平台侧。
    const git = await runRuntimeShell({ app, command: 'test -e .git && echo has-git || echo no-git' });
    expect(git.output.trim()).toBe('no-git');
  }, 600_000);

  it('不注入平台环境变量，另一个 App 的容器与 Workspace 互不可见', async () => {
    const [first, second] = appsUnderTest;
    expect((await ensureAppRuntime({ app: second, workspaceRoot: workspace(second) })).status).toBe('ready');
    await writeFile(join(workspace(first), 'only-in-first.txt'), 'first-only');
    const env = await runRuntimeShell({ app: first, command: 'env' });
    for (const secret of ['DATABASE_URL', 'REDIS_URL', 'APP_ORIGIN', 'PREVIEW_ORIGIN', 'AI_API_KEY', 'MODEL_SECRET_KEY', 'DURABLE_PG_URL']) {
      expect(env.output).not.toContain(secret);
    }
    const cross = await runRuntimeShell({ app: second, command: 'cat only-in-first.txt 2>/dev/null || echo missing' });
    expect(cross.output.trim()).toBe('missing');
    const other = await runRuntimeShell({ app: second, command: 'pwd' });
    expect(other.output).toContain('/work');
    expect(runtimeContainerName(first)).not.toBe(runtimeContainerName(second));
  }, 600_000);

  it('输出超过上限时只回最后一段，完整输出留在运行时日志', async () => {
    const app = appsUnderTest[0];
    const result = await runRuntimeShell({ app, command: 'seq 1 20000' });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(getConfig().appRuntime.shell.outputBytes);
    expect(result.output.trimEnd().endsWith('20000')).toBe(true);
    const log = await readFile(result.logPath, 'utf8');
    expect(Buffer.byteLength(log, 'utf8')).toBeGreaterThan(getConfig().appRuntime.shell.outputBytes);
    // 完整日志从第一行开始就是命令的原始输出，不以换行开头；末行是最后一条。
    const lines = log.split('\n');
    expect(lines[0]).toBe('1');
    expect(lines.filter(line => line.length > 0).at(-1)).toBe('20000');
  }, 600_000);

  it('命令超时后按进程组终止，不再继续修改源码', async () => {
    const app = appsUnderTest[0];
    const marker = join(workspace(app), probe);
    await rm(marker, { force: true });
    const result = await runRuntimeShell({
      app,
      command: `while :; do printf x >> ${probe}; sleep 0.2; done`,
      timeoutMs: 2_500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    const sizeAfterTimeout = (await stat(marker)).size;
    expect(sizeAfterTimeout).toBeGreaterThan(0);
    await new Promise(done => setTimeout(done, 1_500));
    expect((await stat(marker)).size).toBe(sizeAfterTimeout);
  }, 600_000);

  it('取消（AbortSignal）同样终止命令，命令不会继续写文件', async () => {
    const app = appsUnderTest[0];
    const cancelProbe = join(workspace(app), '.paimeng-cancel-probe');
    await rm(cancelProbe, { force: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('测试取消')), 1_200);
    const result = await runRuntimeShell({
      app,
      command: `while :; do printf y >> .paimeng-cancel-probe; sleep 0.2; done`,
      timeoutMs: 120_000,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    const sizeAfterCancel = (await stat(cancelProbe)).size;
    await new Promise(done => setTimeout(done, 1_500));
    expect((await stat(cancelProbe)).size).toBe(sizeAfterCancel);
  }, 600_000);
});
