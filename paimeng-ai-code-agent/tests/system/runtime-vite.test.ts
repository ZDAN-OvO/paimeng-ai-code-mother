import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { appRuntimes, apps, users } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { getConfig } from '@/server/infra/config';
import { workspace } from '@/server/workspace/workspace';
import { appRuntimeKey, runtimeContainerName } from '@/server/runtime/plan';
import { runInRuntime } from '@/server/runtime/commands';
import { readAppRuntime } from '@/server/runtime/store';
import {
  ensureAppRuntime,
  readRuntimeAnonymousMemory,
  reclaimIdleRuntimes,
  stopAppRuntime,
} from '@/server/runtime/supervisor';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.RUNTIME_RUN_ID ??= `vite-${randomUUID().slice(0, 8)}`;

/**
 * 真实 Vite dev server 的验收：冷启动、停掉 dev server 后的热唤醒、三台空闲 runtime 的匿名内存。
 * 前面的 app-runtime 用例只有静态 fixture；这里补的是计划里「真实容器提供模板 dev 页面」那条路径。
 */

const config = getConfig();
const roots: string[] = [];
const appIds: bigint[] = [];
let userId: bigint;

const packageJson = {
  name: 'runtime-vite-fixture',
  private: true,
  type: 'module',
  scripts: { dev: 'vite --host 127.0.0.1' },
  dependencies: {
    react: '19.1.0',
    'react-dom': '19.1.0',
    '@types/react': '19.1.8',
    '@types/react-dom': '19.1.6',
    '@vitejs/plugin-react': '4.6.0',
    typescript: '5.9.3',
    vite: '7.0.0',
  },
};

async function newViteApp() {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({
    id,
    initPrompt: 'Vite runtime 验收',
    codeGenType: 'react_project',
    userId,
    createTime: now(),
    updateTime: now(),
  });
  appIds.push(id);
  const app = { id: String(id), codeGenType: 'react_project' as const };
  const root = workspace(app);
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  await writeFile(
    join(root, 'vite.config.ts'),
    "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
  );
  await writeFile(
    join(root, 'src', 'main.tsx'),
    "import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')!).render(<h1>runtime vite</h1>);\n",
  );
  return app;
}

describe('真实 Vite runtime', () => {
  beforeAll(async () => {
    userId = await nextSnowflakeId();
    await db()
      .insert(users)
      .values({
        id: userId,
        userAccount: 'ts_vite_' + randomUUID(),
        userPassword: 'unused',
        userRole: 'user',
        createTime: now(),
        updateTime: now(),
      });
  });

  afterAll(async () => {
    for (const id of appIds) await db().delete(apps).where(eq(apps.id, id));
    await db().delete(users).where(eq(users.id, userId));
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await getPool().end();
  });

  it('三台 runtime 都起真实 Vite：冷启动可用，停掉 dev server 后热唤醒 ≤15 s，空闲匿名内存合计 ≤768 MiB', async () => {
    const facts: Record<string, unknown> = {};
    const started: {
      app: { id: string; codeGenType: 'react_project' };
      coldMs: number;
      port: number | null;
    }[] = [];

    for (let index = 0; index < 3; index += 1) {
      const app = await newViteApp();
      const coldStarted = Date.now();
      const view = await ensureAppRuntime({ app, workspaceRoot: workspace(app) });
      const coldMs = Date.now() - coldStarted;
      expect(view.status, view.error ?? '').toBe('ready');
      expect(view.port).toBeGreaterThan(0);
      started.push({ app, coldMs, port: view.port });
    }
    facts.coldStartMs = started.map((item) => item.coldMs);

    const memory = [];
    for (const item of started) {
      const bytes = await readRuntimeAnonymousMemory(item.app);
      expect(bytes, 'cgroup anon 必须可读').not.toBeNull();
      memory.push(bytes!);
    }
    facts.anonMiB = memory.map((bytes) => +(bytes / 1024 / 1024).toFixed(1));
    facts.anonTotalMiB = +(memory.reduce((sum, bytes) => sum + bytes, 0) / 1024 / 1024).toFixed(1);
    expect(facts.anonTotalMiB as number).toBeLessThanOrEqual(768);

    const hot = [];
    for (const item of started) {
      // 只停 dev server，容器与依赖保留；下一次 ensure 应原地拉起。
      const killed = await runInRuntime({
        container: runtimeContainerName(item.app, config.appRuntime.runId),
        command: [
          'sh',
          '-c',
          'for c in /proc/[0-9]*/cmdline; do pid=${c#/proc/}; pid=${pid%/cmdline}; [ "$pid" = "$$" ] && continue; if tr "\\0" " " < "$c" 2>/dev/null | grep -q "vite/bin/vite.js"; then kill "$pid" 2>/dev/null || true; fi; done',
        ],
        timeoutMs: 20_000,
      });
      expect(killed.exitCode).toBe(0);
      await new Promise((done) => setTimeout(done, 500));
      const hotStarted = Date.now();
      const view = await ensureAppRuntime({ app: item.app, workspaceRoot: workspace(item.app) });
      hot.push(Date.now() - hotStarted);
      expect(view.status, view.error ?? '').toBe('ready');
    }
    facts.hotWakeMs = hot;
    expect(Math.max(...hot)).toBeLessThanOrEqual(15_000);

    // 缩短空闲判定：把这一台的最后活动时间改到 2020，回收必须在 10 秒内完成。
    const idleApp = started[0].app;
    const record = await db()
      .update(appRuntimes)
      .set({ lastActivityAt: '2020-01-01 00:00:00.000' })
      .where(eq(appRuntimes.appId, BigInt(idleApp.id)));
    expect(record.rowCount).toBe(1);
    const reclaimStarted = Date.now();
    expect(await reclaimIdleRuntimes()).toContain(idleApp.id);
    facts.idleReclaimMs = Date.now() - reclaimStarted;
    expect(facts.idleReclaimMs as number).toBeLessThanOrEqual(10_000);
    const reclaimed = await readAppRuntime(idleApp, config.appRuntime.runId);
    expect(reclaimed?.status).toBe('stopped');

    if (process.env.PROBE_OUTPUT) {
      await mkdir(process.env.PROBE_OUTPUT, { recursive: true });
      await writeFile(
        join(process.env.PROBE_OUTPUT, 'vite.json'),
        JSON.stringify({ ...facts, capturedAt: new Date().toISOString() }, null, 2) + '\n',
      );
    }

    for (const item of started) await stopAppRuntime(item.app);
    expect(appRuntimeKey(started[0].app)).toContain('react_project_');
  }, 1_800_000);
});
