import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { appAuthority, apps, users } from '@/server/infra/schema';
import { runtimeContainerName } from '@/server/runtime/plan';
import { acquireAuthority } from '@/server/generation/control-store';
import { getConfig } from '@/server/infra/config';
import { reclaimIdleRuntimes } from '@/server/runtime/supervisor';
import {
  claimRuntimeSlot,
  listRunRuntimes,
  markAppRuntimeStopped,
  saveAppRuntime,
} from '@/server/runtime/store';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

/**
 * 槽位准入：4 个 App 抢 3 个槽、活动写者不被驱逐、并发领取不超过上限。
 * 这些是跨进程事实，必须由数据库里的预留行与 advisory lock 决定，进程内 Map 不算数。
 */

const appIds: string[] = [];
let userId: bigint;

const appOf = (id: string) => ({ id, codeGenType: 'react_project' as const });
const runId = () => `slot-${randomUUID().slice(0, 8)}`;

async function newApp(): Promise<string> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id,
    initPrompt: '槽位准入',
    codeGenType: 'react_project',
    userId,
    createTime: now(),
    updateTime: now(),
  });
  const key = id.toString();
  appIds.push(key);
  return key;
}

async function ready(id: string, run: string, lastActivityAt: string) {
  await saveAppRuntime(appOf(id), run, {
    containerId: `container-${id}`,
    containerName: runtimeContainerName(appOf(id), run),
    port: 49000,
    imageIdentity: 'image@sha',
    workspaceRoot: `/tmp/slots/${id}`,
    status: 'ready',
    lockDigest: 'c'.repeat(64),
    lastError: null,
    lastActivityAt,
  });
}

function claim(id: string, run: string, maxSlots = 3) {
  return claimRuntimeSlot({
    app: appOf(id),
    runId: run,
    maxSlots,
    staleMs: 60_000,
    containerName: runtimeContainerName(appOf(id), run),
    port: 5173,
    imageIdentity: 'image@sha',
    workspaceRoot: `/tmp/slots/${id}`,
  });
}

async function grantAuthority(id: string) {
  await db().insert(appAuthority).values({
    appId: BigInt(id),
    ownerEpoch: 1,
    holder: 'slot-test',
    state: 'active',
    expiresAt: new Date(Date.now() + 60_000).toISOString().slice(0, 23).replace('T', ' '),
    updateTime: now(),
  });
}

describe('runtime 槽位准入', () => {
  beforeAll(async () => {
    userId = await nextSnowflakeId();
    await db().insert(users).values({
      id: userId,
      userAccount: 'ts_slots_' + randomUUID(),
      userPassword: 'unused',
      userRole: 'user',
      createTime: now(),
      updateTime: now(),
    });
  });

  afterAll(async () => {
    for (const id of appIds) await db().delete(apps).where(eq(apps.id, BigInt(id)));
    await db().delete(users).where(eq(users.id, userId));
    await getPool().end();
  });

  it('4 个 App 抢 3 个槽：驱逐最久未活动且没有写权限的那个，占用数保持 3', async () => {
    const run = runId();
    const oldest = await newApp();
    const middle = await newApp();
    const newest = await newApp();
    await ready(oldest, run, '2020-01-01 00:00:00.000');
    await ready(middle, run, '2020-01-02 00:00:00.000');
    await ready(newest, run, '2020-01-03 00:00:00.000');

    // 事务只给决定：先驱逐（行仍 ready），停掉容器并释放行之后才能重新领取。
    const fourth = await newApp();
    const evicting = await claim(fourth, run);
    expect(evicting.claim).toBe('evict');
    expect(evicting.evicted.map((item) => item.appId)).toEqual([oldest]);
    await markAppRuntimeStopped(appOf(oldest), run, '为新的运行时让出槽位');
    const claimed = await claim(fourth, run);
    expect(claimed.claim).toBe('reserved');

    const rows = await listRunRuntimes(run, ['starting', 'ready']);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.appId)).not.toContain(oldest);
  });

  it('持有写权限的 App 不被驱逐，即使它最久未活动', async () => {
    const run = runId();
    const protectedApp = await newApp();
    const disposable = await newApp();
    await ready(protectedApp, run, '2020-01-01 00:00:00.000');
    await ready(disposable, run, '2020-01-02 00:00:00.000');
    await grantAuthority(protectedApp);

    const claimed = await claim(await newApp(), run, 2);
    expect(claimed.claim).toBe('evict');
    expect(claimed.evicted.map((item) => item.appId)).toEqual([disposable]);
    // 驱逐决定不写台账：调用方停掉容器之前，两行都还在。
    expect((await listRunRuntimes(run, ['ready'])).map((row) => row.appId)).toContain(protectedApp);
  });

  it('所有槽位都在写时返回 full，不驱逐任何活动写者', async () => {
    const run = runId();
    const first = await newApp();
    const second = await newApp();
    await ready(first, run, '2020-01-01 00:00:00.000');
    await ready(second, run, '2020-01-02 00:00:00.000');
    await grantAuthority(first);
    await grantAuthority(second);

    const claimed = await claim(await newApp(), run, 2);
    expect(claimed.claim).toBe('full');
    expect(claimed.evicted).toEqual([]);
    expect(await listRunRuntimes(run, ['ready'])).toHaveLength(2);
  });

  it('同一 App 的并发领取只有一个赢，另一个看到 busy', async () => {
    const run = runId();
    const fresh = await newApp();
    const results = await Promise.all([claim(fresh, run), claim(fresh, run)]);
    expect(results.map((item) => item.claim).sort()).toEqual(['busy', 'reserved']);
  });

  it('空闲回收跳过持权 App，释放后同一 App 才会被回收', async () => {
    const run = getConfig().appRuntime.runId;
    const app = await newApp();
    await ready(app, run, '2020-01-01 00:00:00.000');
    await grantAuthority(app);

    expect(await reclaimIdleRuntimes()).not.toContain(app);
    expect((await listRunRuntimes(run, ['ready'])).map((row) => row.appId)).toContain(app);

    await db()
      .update(appAuthority)
      .set({ state: 'idle', updateTime: now() })
      .where(eq(appAuthority.appId, BigInt(app)));
    expect(await reclaimIdleRuntimes()).toContain(app);
    expect((await listRunRuntimes(run, ['starting', 'ready', 'stopping'])).map((row) => row.appId)).not.toContain(app);
  });

  it('正在回收的 runtime 挡住新的写权限', async () => {
    const run = getConfig().appRuntime.runId;
    const app = await newApp();
    await ready(app, run, '2020-01-01 00:00:00.000');
    await claim(await newApp(), run, 1);
    // claim 已把被驱逐的行标成 stopping；此时取得写权限必须被拒绝。
    await expect(acquireAuthority({ appId: app, generationId: '1', holder: 'slot-test', ttlMs: 30_000 })).rejects.toThrow(
      /正在回收/,
    );
  });

  it('并发领取不同 App 也不会超过槽位上限', async () => {
    const run = runId();
    const contenders = await Promise.all([1, 2, 3, 4, 5].map(() => newApp()));
    const results = await Promise.all(contenders.map((id) => claim(id, run, 2)));
    expect(results.every((item) => item.claim === 'reserved' || item.claim === 'full')).toBe(true);
    expect((await listRunRuntimes(run, ['starting', 'ready'])).length).toBeLessThanOrEqual(2);
  });
});
