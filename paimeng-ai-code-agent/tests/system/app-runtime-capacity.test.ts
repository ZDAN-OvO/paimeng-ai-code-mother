import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createServer as createNetServer } from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import type { Server } from 'node:http';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, generationExecutions, generations, users } from '@/server/infra/schema';
import { initializeTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate } from '@/server/templates/templates';
import { ensureRuntime, ensureSafeDirectory, workspace, type WorkspaceApp } from '@/server/workspace/workspace';
import { getConfig } from '@/server/infra/config';
import {
  ensureAppRuntime, evictForWaitingGenerations, readRuntimeAnonymousMemory, reclaimIdleRuntimes,
  runtimeCapacitySnapshot, stopAppRuntime,
} from '@/server/app-runtime/supervisor';
import { cancelQueuedGeneration } from '@/server/app-runtime/scheduler';
import { appRuntimeKey, runtimeContainerName, runtimePaths } from '@/server/app-runtime/plan';
import { readAppRuntime, updateAppRuntime } from '@/server/app-runtime/store';
import { failOrCancel, launchQueuedGeneration, prepareGenerationStart, startGeneration } from '@/server/generation/generation-lifecycle';
import { createPreviewServer } from '@/server/delivery/preview';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout.trim());

/**
 * #144 真实 Docker 容量验收：槽位上限、空闲回收、LRU 驱逐、写权限保护、静态回落与再次唤醒。
 * 超时/队列全部用秒级配置压短，容器、pnpm、dev server、预览代理都是真的；模型不参与。
 */

const template = resolveTemplate('react-ts', '2.0.0');
const createdApps: WorkspaceApp[] = [];
const appA: WorkspaceApp = { id: '', codeGenType: 'react_project' };
const appB: WorkspaceApp = { id: '', codeGenType: 'react_project' };
const appC: WorkspaceApp = { id: '', codeGenType: 'react_project' };
let userId: bigint;
let preview: Server | undefined;
let previewPort = 0;
const previousOrigin = process.env.PREVIEW_ORIGIN;
const previousEnv = {
  RUNTIME_MAX_SLOTS: process.env.RUNTIME_MAX_SLOTS,
  RUNTIME_IDLE_TIMEOUT_MS: process.env.RUNTIME_IDLE_TIMEOUT_MS,
  RUNTIME_QUEUE_POLL_MS: process.env.RUNTIME_QUEUE_POLL_MS,
  RUNTIME_SUPERVISOR_TICK_MS: process.env.RUNTIME_SUPERVISOR_TICK_MS,
};

function freePort() {
  const probe = createNetServer();
  return new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

const containerRunning = (app: WorkspaceApp) => docker(['inspect', '--format', '{{.State.Running}}', runtimeContainerName(app)]).catch(() => 'missing');
const twoMinutesAgo = () => new Date(Date.now() - 120_000).toISOString().slice(0, 23).replace('T', ' ');

async function newApp(app: WorkspaceApp, label: string) {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, appName: label, initPrompt: 'capacity', codeGenType: app.codeGenType, userId, createTime: now(), updateTime: now() });
  app.id = id.toString();
  createdApps.push(app);
  await ensureSafeDirectory(join(await ensureRuntime(), 'code_output'));
  await initializeTemplate(app, template);
}

describe('真实 Docker 上的运行时容量', () => {
  beforeAll(async () => {
    process.env.APP_RUNTIME_ENABLED = 'true';
    process.env.RUNTIME_MAX_SLOTS = '2';
    process.env.RUNTIME_IDLE_TIMEOUT_MS = '1500';
    process.env.RUNTIME_QUEUE_POLL_MS = '200';
    // 常驻 tick 拉长：本套用例自己调用容量维护，避免定时器在两段断言之间改变状态。
    process.env.RUNTIME_SUPERVISOR_TICK_MS = '600000';
    userId = await nextSnowflakeId();
    await db().insert(users).values({ id: userId, userAccount: 'ts_capacity_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    await newApp(appA, '容量 A');
    await newApp(appB, '容量 B');
    await newApp(appC, '容量 C');
    previewPort = await freePort();
    process.env.PREVIEW_ORIGIN = `http://127.0.0.1:${previewPort}`;
    preview = await createPreviewServer({ runtimeRoot: getConfig().runtimeRoot, devServerCacheMs: 0 });
    await new Promise<void>((resolve, reject) => { preview!.once('error', reject); preview!.listen(previewPort, '127.0.0.1', resolve); });
  }, 600_000);

  afterAll(async () => {
    for (const app of createdApps) {
      await stopAppRuntime(app).catch(() => undefined);
      await rm(runtimePaths(getConfig().runtimeRoot, app).base, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace(app), { recursive: true, force: true }).catch(() => undefined);
    }
    if (createdApps.length) {
      const ids = createdApps.map(app => BigInt(app.id));
      await db().delete(generationExecutions).where(inArray(generationExecutions.appId, ids)).catch(() => undefined);
      await db().delete(generations).where(inArray(generations.appId, ids)).catch(() => undefined);
      await db().delete(apps).where(inArray(apps.id, ids)).catch(() => undefined);
    }
    if (preview) await new Promise<void>(resolve => preview!.close(() => resolve())).catch(() => undefined);
    if (userId) await db().delete(users).where(eq(users.id, userId)).catch(() => undefined);
    if (previousOrigin === undefined) delete process.env.PREVIEW_ORIGIN;
    else process.env.PREVIEW_ORIGIN = previousOrigin;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('两个 App 并行占满槽位，第三个 Generation 持久化为 queued 且并发占槽不超过上限', async () => {
    expect((await ensureAppRuntime({ app: appA, workspaceRoot: workspace(appA) })).status).toBe('ready');
    expect((await ensureAppRuntime({ app: appB, workspaceRoot: workspace(appB) })).status).toBe('ready');
    expect(await containerRunning(appA)).toBe('true');
    expect(await containerRunning(appB)).toBe('true');

    const prepared = await prepareGenerationStart({
      app: appC, userId: String(userId), requestId: `cap-${randomUUID()}`, holder: 'capacity-test',
      prompt: '排队', template: null,
    });
    expect(prepared.kind).toBe('queued');
    const snapshot = await runtimeCapacitySnapshot();
    expect(snapshot.slots).toMatchObject({ used: 2, limit: 2 });
    expect(snapshot.queue).toMatchObject({ waiting: 1, limit: 20 });
    expect(await containerRunning(appC)).toBe('missing');
    if (prepared.kind === 'queued') await cancelQueuedGeneration({ app: appC, generationId: prepared.plan.generationId });
  }, 900_000);

  it('空闲超过配置时长后真实容器被回收；Preview 静态回落且查看不唤醒，下一轮从持久 Workspace 重建', async () => {
    const before = await readAppRuntime(appA);
    expect(before?.status).toBe('ready');
    // 上一轮装入的依赖留在 Workspace 里：回收只停容器，不删源码与 node_modules。
    const marker = join(workspace(appA), 'node_modules/.paimeng-capacity-marker');
    await writeFile(marker, 'installed');
    await mkdir(join(workspace(appA), 'dist'), { recursive: true });
    await writeFile(join(workspace(appA), 'dist', 'index.html'), '<!doctype html><html><body><h1>睡眠后的静态页</h1></body></html>');
    await updateAppRuntime(appA, { lastActivityAt: twoMinutesAgo() });

    expect(await reclaimIdleRuntimes()).toContain(appA.id);
    expect(await containerRunning(appA)).toBe('missing');
    expect(await readAppRuntime(appA)).toMatchObject({ status: 'stopped' });

    // 查看 Preview：走静态产物；台账仍是 stopped、容器仍不存在，说明没有被唤醒。
    const staticPage = await fetch(`http://127.0.0.1:${previewPort}/preview/${appRuntimeKey(appA)}/`, { signal: AbortSignal.timeout(10_000) });
    expect(staticPage.status).toBe(200);
    expect(await staticPage.text()).toContain('睡眠后的静态页');
    expect(await readAppRuntime(appA)).toMatchObject({ status: 'stopped' });
    expect(await containerRunning(appA)).toBe('missing');

    // 下一轮惰性唤醒：从同一份持久 Workspace 重建，依赖标记还在。
    const rebuilt = await ensureAppRuntime({ app: appA, workspaceRoot: workspace(appA) });
    expect(rebuilt.status).toBe('ready');
    expect(rebuilt.containerId).not.toBe(before?.containerId);
    expect(await readFile(marker, 'utf8')).toBe('installed');
    const live = await fetch(`http://127.0.0.1:${rebuilt.port}/preview/${appRuntimeKey(appA)}/`, { signal: AbortSignal.timeout(10_000) });
    expect(live.status).toBe(200);
  }, 900_000);

  it('槽位满时按 LRU 驱逐最久未活动、没有写权限的 runtime，让等待者拿到槽位并启动', async () => {
    process.env.RUNTIME_MAX_SLOTS = '1';
    // B 也让它退出，只留 A 占着唯一槽位。
    await stopAppRuntime(appB);
    // A 的写权限为空、活动时间更早 → 是 LRU 驱逐对象。
    await updateAppRuntime(appA, { lastActivityAt: twoMinutesAgo() });
    const prepared = await prepareGenerationStart({
      app: appC, userId: String(userId), requestId: `cap-${randomUUID()}`, holder: 'capacity-test',
      prompt: '驱逐后启动', template: null,
    });
    if (prepared.kind !== 'queued') throw new Error('槽位满时应当排队');
    const evicted = await evictForWaitingGenerations();
    expect(evicted).toContain(appA.id);
    expect(await containerRunning(appA)).toBe('missing');
    expect((await readAppRuntime(appA))?.status).toBe('stopped');

    const started = await launchQueuedGeneration(prepared.plan);
    expect(started.execution?.directory).toBe(workspace(appC));
    const view = await ensureAppRuntime({ app: appC, workspaceRoot: started.execution!.directory });
    expect(view.status).toBe('ready');
    expect(await containerRunning(appC)).toBe('true');
    expect(await readRuntimeAnonymousMemory(appC)).toBeGreaterThan(0);
    await failOrCancel({
      app: appC, generationId: started.generationId, epoch: started.epoch!,
      execution: started.execution!, outcome: 'cancelled', error: 'capacity done',
    });
  }, 900_000);

  it('持有 Write authority 的 App 既不被空闲回收也不被驱逐，等待者继续排队', async () => {
    process.env.RUNTIME_MAX_SLOTS = '1';
    const running = await startGeneration({
      app: appC, userId: String(userId), requestId: `cap-${randomUUID()}`, holder: 'capacity-test',
      prompt: '占住写权限', template: null,
    });
    expect(running.epoch).not.toBeNull();
    const prepared = await prepareGenerationStart({
      app: appA, userId: String(userId), requestId: `cap-${randomUUID()}`, holder: 'capacity-test',
      prompt: '等待受保护者', template: null,
    });
    if (prepared.kind !== 'queued') throw new Error('槽位满时应当排队');
    await updateAppRuntime(appC, { lastActivityAt: twoMinutesAgo() });
    expect(await reclaimIdleRuntimes()).not.toContain(appC.id);
    expect(await evictForWaitingGenerations()).not.toContain(appC.id);
    expect(await containerRunning(appC)).toBe('true');
    expect((await readAppRuntime(appC))?.status).toBe('ready');
    expect((await readAppRuntime(appA))?.status).toBe('stopped');
    await cancelQueuedGeneration({ app: appA, generationId: prepared.plan.generationId });
    await failOrCancel({
      app: appC, generationId: running.generationId, epoch: running.epoch!,
      execution: running.execution!, outcome: 'cancelled', error: 'capacity done',
    });
  }, 900_000);
});
