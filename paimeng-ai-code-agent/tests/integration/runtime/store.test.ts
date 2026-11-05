import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { appAuthority, apps, users } from '@/server/infra/schema';
import {
  appHasWriteAuthority,
  deleteAppRuntime,
  listAppRuntimes,
  readAppRuntime,
  saveAppRuntime,
  touchAppRuntime,
  updateAppRuntime,
} from '@/server/runtime/store';
import { runtimePreviewTarget } from '@/server/runtime/supervisor';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

let userId: bigint;
let appId = '';
const runId = 'store-run';
const app = () => ({ id: appId, codeGenType: 'react_project' as const });
const future = () => new Date(Date.now() + 60_000).toISOString().slice(0, 23).replace('T', ' ');

const record = () => ({
  containerId: 'a'.repeat(64),
  containerName: `paimeng-app-runtime-${runId}-react_project_${appId}`,
  port: 49153,
  imageIdentity: 'paimeng-app-runtime:abc@sha256:def',
  workspaceRoot: '/tmp/executions/gen/1',
  status: 'ready' as const,
  lockDigest: 'b'.repeat(64),
  lastError: null,
});

describe('App runtime 台账', () => {
  beforeAll(async () => {
    userId = await nextSnowflakeId();
    await db().insert(users).values({
      id: userId,
      userAccount: 'ts_runtime_' + randomUUID(),
      userPassword: 'unused',
      userRole: 'user',
      createTime: now(),
      updateTime: now(),
    });
  });

  afterEach(async () => {
    if (appId) await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    appId = '';
  });

  afterAll(async () => {
    await db().delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  async function newApp() {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({
      id,
      initPrompt: '运行时台账',
      codeGenType: 'react_project',
      userId,
      createTime: now(),
      updateTime: now(),
    });
    appId = id.toString();
  }

  it('一个 App 一行：保存、读取、推进活动时间、状态与错误、删除', async () => {
    await newApp();
    expect(await readAppRuntime(app(), runId)).toBeNull();
    const saved = await saveAppRuntime(app(), runId, record());
    expect(saved).toMatchObject({ appId, port: 49153, status: 'ready', lockDigest: 'b'.repeat(64) });
    expect((await readAppRuntime(app(), runId))?.imageIdentity).toBe(record().imageIdentity);

    await touchAppRuntime(app(), runId, '2030-01-01 00:00:00.000');
    expect((await readAppRuntime(app(), runId))?.lastActivityAt).toBe('2030-01-01 00:00:00');

    await updateAppRuntime(app(), runId, { status: 'failed', lastError: '安装失败', port: 49154 });
    expect(await readAppRuntime(app(), runId)).toMatchObject({ status: 'failed', lastError: '安装失败', port: 49154 });

    // 同一 App 的第二次保存覆盖同一行，不产生第二份运行时。
    await saveAppRuntime(app(), runId, { ...record(), workspaceRoot: '/tmp/executions/gen/2', status: 'starting' });
    expect(await readAppRuntime(app(), runId)).toMatchObject({ workspaceRoot: '/tmp/executions/gen/2', status: 'starting' });

    await deleteAppRuntime(app(), runId);
    expect(await readAppRuntime(app(), runId)).toBeNull();
  });

  it('同一 App 的两轮 run 各自一行：读、写、删都不互相覆盖', async () => {
    await newApp();
    await saveAppRuntime(app(), 'run-a', { ...record(), containerName: `a-${appId}` });
    await saveAppRuntime(app(), 'run-b', { ...record(), containerName: `b-${appId}` });
    expect((await readAppRuntime(app(), 'run-a'))?.containerName).toBe(`a-${appId}`);
    expect((await readAppRuntime(app(), 'run-b'))?.containerName).toBe(`b-${appId}`);
    expect(await listAppRuntimes(undefined, 'run-a')).toHaveLength(1);
    await deleteAppRuntime(app(), 'run-a');
    expect(await readAppRuntime(app(), 'run-a')).toBeNull();
    expect(await readAppRuntime(app(), 'run-b')).not.toBeNull();
  });

  it('已回收（stopped）的 runtime 不再提供 dev server 目标：Preview 走静态回落，查看不会唤醒', async () => {
    await newApp();
    await saveAppRuntime(app(), runId, record());
    await updateAppRuntime(app(), runId, { status: 'stopped', lastError: '空闲超时，已回收运行时' });
    expect(await runtimePreviewTarget(app())).toBeNull();
    // 仍保留台账行（管理员能看到最后活动与回收原因），但不再算作槽位占用。
    expect(await readAppRuntime(app(), runId)).toMatchObject({ status: 'stopped', lastError: '空闲超时，已回收运行时' });
  });

  it('写权限活跃时预览必须只读，收束后恢复', async () => {
    await newApp();
    expect(await appHasWriteAuthority(app())).toBe(false);
    await db().insert(appAuthority).values({
      appId: BigInt(appId),
      ownerEpoch: 1,
      holder: 'test',
      state: 'active',
      expiresAt: future(),
      updateTime: now(),
    });
    expect(await appHasWriteAuthority(app())).toBe(true);
    await db()
      .update(appAuthority)
      .set({ state: 'draining', holder: null, updateTime: now() })
      .where(eq(appAuthority.appId, BigInt(appId)));
    expect(await appHasWriteAuthority(app())).toBe(true);
    await db()
      .update(appAuthority)
      .set({ state: 'idle', updateTime: now() })
      .where(eq(appAuthority.appId, BigInt(appId)));
    expect(await appHasWriteAuthority(app())).toBe(false);
  });
});
