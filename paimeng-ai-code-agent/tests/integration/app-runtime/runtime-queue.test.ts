import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appAuthority, appRuntimeQueue, appRuntimes, apps, creditCharges, creditEntries, generationExecutions, generations, users,
} from '@/server/infra/schema';
import { generationFor } from '@/server/generation/generation-store';
import { launchQueuedGeneration, prepareGenerationStart } from '@/server/generation/generation-lifecycle';
import { cancelQueuedGeneration, queuedGenerationView, releaseRuntimeSlot } from '@/server/app-runtime/scheduler';
import { maintainRuntimeCapacity, stopRuntimeMaintenance } from '@/server/app-runtime/supervisor';
import { readQueueTicket, waitingQueue } from '@/server/app-runtime/queue';
import type { WorkspaceApp } from '@/server/workspace/workspace';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 运行时容量排队（#144）：真 Postgres，不起 Docker。容器本身由 system 套件验证；
 * 这里断言排队/批准/超时/取消/重启对账这些「状态迁移」事实，以及排队不产生 Credit。
 */

const previousEnv = {
  APP_RUNTIME_ENABLED: process.env.APP_RUNTIME_ENABLED,
  RUNTIME_MAX_SLOTS: process.env.RUNTIME_MAX_SLOTS,
  RUNTIME_QUEUE_LIMIT: process.env.RUNTIME_QUEUE_LIMIT,
  RUNTIME_QUEUE_WAIT_TIMEOUT_MS: process.env.RUNTIME_QUEUE_WAIT_TIMEOUT_MS,
  RUNTIME_QUEUE_POLL_MS: process.env.RUNTIME_QUEUE_POLL_MS,
  RUNTIME_QUEUE_LEASE_MS: process.env.RUNTIME_QUEUE_LEASE_MS,
  RUNTIME_IDLE_TIMEOUT_MS: process.env.RUNTIME_IDLE_TIMEOUT_MS,
};

let userId: bigint;
let runtimeRoot = '';
let snapshotsRoot = '';
const createdApps: bigint[] = [];
const appsById = new Map<string, WorkspaceApp>();
let counter = 0;

const appOf = (id: string): WorkspaceApp => appsById.get(id)!;

async function newApp(): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  counter += 1;
  await db().insert(apps).values({
    id, appName: `排队测试 ${counter}`, initPrompt: 'queue', codeGenType: 'react_project',
    userId, createTime: now(), updateTime: now(),
  });
  createdApps.push(id);
  const app: WorkspaceApp = { id: String(id), codeGenType: 'react_project' };
  appsById.set(app.id, app);
  return app;
}

/** 占住一个槽位的真实台账行（不启容器）：容量判定只看台账与写权限。 */
async function occupySlot(app: WorkspaceApp) {
  await db().insert(appRuntimes).values({
    appId: BigInt(app.id), containerId: 'a'.repeat(64), containerName: `paimeng-app-runtime-${app.codeGenType}_${app.id}`,
    port: 49153, imageIdentity: 'paimeng-app-runtime:test@sha256:test', workspaceRoot: '/tmp/queue-test',
    status: 'ready', lockDigest: null, lastError: null, lastActivityAt: now(), createTime: now(), updateTime: now(),
  });
}

async function protectSlot(app: WorkspaceApp) {
  await db().insert(appAuthority).values({
    appId: BigInt(app.id), ownerEpoch: 1, holder: 'queue-test', state: 'active',
    expiresAt: new Date(Date.now() + 600_000).toISOString().slice(0, 23).replace('T', ' '), updateTime: now(),
  }).onConflictDoUpdate({ target: appAuthority.appId, set: { state: 'active', ownerEpoch: 1, expiresAt: sql`timezone('UTC', now()) + interval '10 minutes'` } });
}

async function generationRow(id: string) {
  const [row] = await db().select().from(generations).where(eq(generations.id, id));
  return row ?? null;
}

describe('运行时槽位排队', () => {
  beforeAll(async () => {
    userId = await nextSnowflakeId();
    await db().insert(users).values({ id: userId, userAccount: 'ts_queue_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    runtimeRoot = await mkdtemp(join(tmpdir(), 'paimeng-queue-runtime-'));
    snapshotsRoot = join(runtimeRoot, 'snapshots');
    process.env.APP_RUNTIME_ENABLED = 'true';
    process.env.RUNTIME_MAX_SLOTS = '1';
    process.env.RUNTIME_QUEUE_LIMIT = '1';
    process.env.RUNTIME_QUEUE_WAIT_TIMEOUT_MS = '1000';
    process.env.RUNTIME_QUEUE_POLL_MS = '100';
    process.env.RUNTIME_QUEUE_LEASE_MS = '5000';
    process.env.RUNTIME_IDLE_TIMEOUT_MS = '1000';
  });

  afterEach(async () => {
    stopRuntimeMaintenance();
    if (!createdApps.length) return;
    const charges = await db().select({ id: creditCharges.generationId }).from(creditCharges).where(inArray(creditCharges.appId, createdApps));
    if (charges.length) await db().delete(creditEntries).where(inArray(creditEntries.chargeId, charges.map(row => row.id))).catch(() => undefined);
    await db().delete(creditCharges).where(inArray(creditCharges.appId, createdApps)).catch(() => undefined);
    await db().delete(generations).where(inArray(generations.appId, createdApps)).catch(() => undefined);
    await db().delete(apps).where(inArray(apps.id, createdApps)).catch(() => undefined);
    createdApps.length = 0;
    appsById.clear();
    runtimeRoot = await mkdtemp(join(tmpdir(), 'paimeng-queue-runtime-'));
    snapshotsRoot = join(runtimeRoot, 'snapshots');
    process.env.RUNTIME_QUEUE_WAIT_TIMEOUT_MS = '1000';
  });

  afterAll(async () => {
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await db().delete(users).where(eq(users.id, userId));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  const startInput = (app: WorkspaceApp) => ({
    app, userId: String(userId), requestId: `req-${randomUUID()}`, holder: 'queue-test',
    prompt: '排队一轮', template: null, runtimeRoot, snapshotsRoot,
  });

  it('没有空闲槽位时 Generation 落成 queued 并持久化排队记录，不抢写权限也不建执行', async () => {
    const busy = await newApp();
    await occupySlot(busy);
    await protectSlot(busy);
    const waiting = await newApp();
    const prepared = await prepareGenerationStart(startInput(waiting));
    expect(prepared.kind).toBe('queued');
    if (prepared.kind !== 'queued') return;
    expect(await generationRow(prepared.plan.generationId)).toMatchObject({ status: 'queued', error: null });
    expect(await readQueueTicket(waiting)).toMatchObject({ state: 'waiting', generationId: prepared.plan.generationId });
    expect(await queuedGenerationView(waiting)).toEqual({ position: 1, waiting: 1, waitDeadline: expect.any(String) });
    const [authority] = await db().select().from(appAuthority).where(eq(appAuthority.appId, BigInt(waiting.id)));
    expect(authority?.state ?? 'idle').toBe('idle');
    expect(await db().select().from(generationExecutions).where(eq(generationExecutions.generationId, prepared.plan.generationId))).toHaveLength(0);
    // 刷新后的状态读取（`generationFor`）必须仍能看到 queued。
    expect((await generationFor(waiting.id))?.status).toBe('queued');
  });

  it('槽位空出后按 FIFO 自动批准；同一条 Generation 重复启动只产生一次执行', async () => {
    const busy = await newApp();
    await occupySlot(busy);
    await protectSlot(busy);
    const first = await newApp();
    const second = await newApp();
    const firstPrep = await prepareGenerationStart(startInput(first));
    const secondPrep = await prepareGenerationStart(startInput(second)).catch(error => error);
    // 队列上限 1：第二个等待者被明确拒绝，而不是无声排到队尾。
    expect(secondPrep).toMatchObject({ status: 429 });
    expect((secondPrep as Error).message).toContain('排队已满');
    if (firstPrep.kind !== 'queued') throw new Error('期望第一个请求进入排队');

    // 空出一个槽位：先回收占用者（删台账行），再由容量维护批准队首。
    await db().delete(appRuntimes).where(eq(appRuntimes.appId, BigInt(busy.id)));
    const outcome = await maintainRuntimeCapacity();
    expect(outcome.granted).toContain(first.id);
    expect((await readQueueTicket(first))?.state).toBe('granted');

    const started = await launchQueuedGeneration(firstPrep.plan);
    expect(started.execution?.directory).toBeDefined();
    expect((await generationRow(started.generationId))?.status).toBe('generating');
    expect(await db().select().from(generationExecutions).where(eq(generationExecutions.generationId, started.generationId))).toHaveLength(1);
    // 重复事件/并发启动：第二次必须被条件更新挡住，不会再建一条执行。
    await expect(launchQueuedGeneration(firstPrep.plan)).rejects.toMatchObject({ status: 409 });
    expect(await db().select().from(generationExecutions).where(eq(generationExecutions.generationId, started.generationId))).toHaveLength(1);
    await releaseRuntimeSlot(first, started.generationId);
  });

  it('排队等待超时落 failed/timeout 并给出可读原因，排队期间没有 Credit 账单', async () => {
    const busy = await newApp();
    await occupySlot(busy);
    await protectSlot(busy);
    const waiting = await newApp();
    const prepared = await prepareGenerationStart(startInput(waiting));
    if (prepared.kind !== 'queued') throw new Error('期望进入排队');
    // 排队期间：还没有账单，也没有消耗分录。
    expect(await db().select().from(creditCharges).where(eq(creditCharges.generationId, prepared.plan.generationId))).toHaveLength(0);
    expect(await db().select().from(creditEntries)).toHaveLength(0);

    await expect(launchQueuedGeneration(prepared.plan)).rejects.toMatchObject({ status: 429 });
    const row = await generationRow(prepared.plan.generationId);
    expect(row).toMatchObject({ status: 'failed', stopReason: 'timeout' });
    expect(row?.error).toContain('排队等待超时');
    expect(await readQueueTicket(waiting)).toBeNull();
    const [charge] = await db().select().from(creditCharges).where(eq(creditCharges.generationId, prepared.plan.generationId));
    expect(charge?.credits ?? 0).toBe(0);
    expect(await db().select().from(creditEntries)).toHaveLength(0);
  });

  it('排队可以被取消：落 cancelled、删排队记录，之后不会启动', async () => {
    const busy = await newApp();
    await occupySlot(busy);
    await protectSlot(busy);
    const waiting = await newApp();
    const prepared = await prepareGenerationStart(startInput(waiting));
    if (prepared.kind !== 'queued') throw new Error('期望进入排队');
    expect(await cancelQueuedGeneration({ app: waiting, generationId: prepared.plan.generationId })).toBe(true);
    expect(await generationRow(prepared.plan.generationId)).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    expect(await readQueueTicket(waiting)).toBeNull();
    await expect(launchQueuedGeneration(prepared.plan)).rejects.toMatchObject({ status: 409 });
    const [charge] = await db().select().from(creditCharges).where(eq(creditCharges.generationId, prepared.plan.generationId));
    expect(charge?.credits ?? 0).toBe(0);
  });

  it('进程重启留下的等待者收敛成 failed/interrupted，不会被重新启动', async () => {
    const busy = await newApp();
    await occupySlot(busy);
    await protectSlot(busy);
    const waiting = await newApp();
    const prepared = await prepareGenerationStart(startInput(waiting));
    if (prepared.kind !== 'queued') throw new Error('期望进入排队');
    await db().execute(sql`update app_runtime_queue set heartbeat_at = timezone('UTC', now()) - interval '1 hour' where app_id = ${BigInt(waiting.id)}`);
    const outcome = await maintainRuntimeCapacity();
    expect(outcome.abandoned).toContain(prepared.plan.generationId);
    expect(await generationRow(prepared.plan.generationId)).toMatchObject({ status: 'failed', stopReason: 'interrupted' });
    expect(await readQueueTicket(waiting)).toBeNull();
    expect(await db().select().from(generationExecutions).where(eq(generationExecutions.generationId, prepared.plan.generationId))).toHaveLength(0);
    await expect(launchQueuedGeneration(prepared.plan)).rejects.toMatchObject({ status: 409 });
    expect(await waitingQueue()).toHaveLength(0);
  });
});
