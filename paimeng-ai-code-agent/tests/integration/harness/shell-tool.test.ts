import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, generations } from '@/server/infra/schema';
import { acquireAuthority, bindExecutionConversation, createExecution, reserveAttempt, setExecutionStatus } from '@/server/generation/control-store';
import {
  baseUrl,
  freePort,
  harnessAvailable,
  postgresReachable,
  postgresUrl,
  productPostgresUrl,
  startHarness,
  stopHarness,
  waitForState,
  waitHealthy,
  type HarnessProcess,
  type HarnessState,
} from './support';

/**
 * shell 工具在真实 harness 里的注册、执行门禁与条数预算。
 * 这里不启动 Docker：被验证的两条路径都在执行命令之前就返回——
 * 封存后的执行被 effect gate 拒绝，超出 40 条的调用被 attempt 预算拒绝。
 */
process.env.DATABASE_URL = productPostgresUrl;

const harnessReady = harnessAvailable();
const productReady = harnessReady && (await postgresReachable(productPostgresUrl));
const storageReady = productReady && (await postgresReachable(postgresUrl));
const ready = harnessReady && productReady && storageReady;

let actorId: bigint;
const createdApps: bigint[] = [];
const createdGenerations: string[] = [];
let syntheticConversation = 860_000;

async function newContext(status: 'active' | 'sealed'): Promise<{ appId: string; generationId: string; executionId: string }> {
  const appId = String(await nextSnowflakeId());
  await db().insert(apps).values({ id: BigInt(appId), appName: 'shell 工具测试', initPrompt: 'shell', codeGenType: 'react_project', userId: actorId, createTime: now(), updateTime: now() });
  createdApps.push(BigInt(appId));
  const generationId = randomUUID();
  await db().insert(generations).values({ id: generationId, appId: BigInt(appId), userId: actorId, status: 'generating', createTime: now(), updateTime: now() });
  createdGenerations.push(generationId);
  const authority = await acquireAuthority({ appId, generationId, holder: 'shell-tool-test', ttlMs: 300_000 });
  const execution = await createExecution({
    appId, generationId, epoch: authority.epoch,
    directory: `runtime/executions/${generationId}/${authority.epoch}`, baselineKind: 'empty',
  });
  await setExecutionStatus(execution.id, status);
  // 已封存的执行不允许再绑定会话；门禁绑定由 harness 的 /conversations app 字段建立。
  if (status === 'active') {
    syntheticConversation += 1;
    await bindExecutionConversation(execution.id, syntheticConversation);
  }
  return { appId, generationId, executionId: execution.id };
}

type Started = { base: string; harness: HarnessProcess };

async function startShellHarness(options: { runDir: string; workspace: string; command: string; finalText: string; env?: Record<string, string> }): Promise<Started> {
  mkdirSync(options.workspace, { recursive: true });
  const port = await freePort();
  const base = baseUrl(port);
  const harness = startHarness({
    port, runDir: options.runDir, reset: true, waitMs: 0, finalText: options.finalText,
    workspace: options.workspace, tool: 'shell', args: { command: options.command },
    databaseUrl: productPostgresUrl, ...(options.env ? { env: options.env } : {}),
  });
  await waitHealthy(base, 60_000);
  return { base, harness };
}

async function createConversation(base: string, body: Record<string, unknown>): Promise<number> {
  const created = await fetch(`${base}/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (created.status !== 201) throw new Error(`create conversation ${created.status}: ${await created.text()}`);
  return ((await created.json()) as { conversationId: number }).conversationId;
}

async function submit(base: string, conversationId: number, content: string, requestId: string): Promise<void> {
  const response = await fetch(`${base}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, content, requestId }) });
  if (response.status !== 202) throw new Error(`submit ${response.status}: ${await response.text()}`);
}

async function toolResultText(base: string, conversationId: number, finalText: string): Promise<string> {
  const settled: HarnessState = await waitForState(
    base, (state) => state.view.entries.some((entry) => entry.kind === 'pi.assistant' && entry.text.includes(finalText)),
    90_000, 'run settles', conversationId,
  );
  return settled.view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.text).join('\n');
}

const appField = (context: { appId: string; generationId: string; executionId: string }) => ({
  id: context.appId, codeGenType: 'react_project', generationId: context.generationId, executionId: context.executionId,
});

describe.skipIf(!ready)('harness 注册 shell 工具：写权限门禁与每轮条数预算', () => {
  beforeAll(async () => {
    process.env.GENERATION_MAX_CONCURRENT = '64';
    actorId = await nextSnowflakeId();
  });

  afterAll(async () => {
    if (createdApps.length > 0) await db().delete(apps).where(inArray(apps.id, createdApps));
    if (createdGenerations.length > 0) await db().delete(generations).where(inArray(generations.id, createdGenerations));
    await getPool().end();
  });

  it('/tools 提供 shell，且标记为不可重放', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'durable-shell-tools-'));
    const workspace = join(runDir, 'app');
    const context = await newContext('active');
    const started = await startShellHarness({ runDir, workspace, command: 'echo probe', finalText: 'SHELL_TOOLS_DONE' });
    try {
      const body = (await (await fetch(`${started.base}/tools`)).json()) as { tools: { name: string; replay: string }[] };
      const shell = body.tools.find((tool) => tool.name === 'shell');
      expect(shell).toBeDefined();
      expect(shell?.replay).toBe('unsafe');
      expect(body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['read', 'write', 'listFiles', 'git', 'buildPreview', 'shell']));
    } finally {
      await stopHarness(started.harness);
      rmSync(runDir, { recursive: true, force: true });
      await setExecutionStatus(context.executionId, 'failed');
    }
  }, 180_000);

  it('执行封存后 shell 与文件工具一样被拒绝，命令不会落盘', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'durable-shell-gate-'));
    const workspace = join(runDir, 'app');
    const context = await newContext('sealed');
    const started = await startShellHarness({ runDir, workspace, command: 'printf ran > shell-ran.txt', finalText: 'SHELL_GATE_DONE' });
    try {
      const conversationId = await createConversation(started.base, {
        workspace, instructions: '只能用 shell。', title: 'shell-sealed', app: appField(context),
      });
      await submit(started.base, conversationId, '跑一条命令', 'shell-sealed');
      const result = await toolResultText(started.base, conversationId, 'SHELL_GATE_DONE');
      expect(result).toContain('本轮已停止写入');
      expect(() => statSync(join(workspace, 'shell-ran.txt'))).toThrow();
    } finally {
      await stopHarness(started.harness);
      rmSync(runDir, { recursive: true, force: true });
      await setExecutionStatus(context.executionId, 'failed');
    }
  }, 240_000);

  it('每轮 40 条上限：第 41 条被预算拒绝，命令不执行', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'durable-shell-budget-'));
    const workspace = join(runDir, 'app');
    const context = await newContext('active');
    for (let index = 0; index < 40; index += 1) {
      await reserveAttempt({ executionId: context.executionId, kind: 'shell', scope: 'command', limit: 40, requestSummary: { tool: 'shell' } });
    }
    const started = await startShellHarness({ runDir, workspace, command: 'printf ran > shell-budget.txt', finalText: 'SHELL_BUDGET_DONE' });
    try {
      const conversationId = await createConversation(started.base, {
        workspace, instructions: '只能用 shell。', title: 'shell-budget', app: appField(context),
      });
      await submit(started.base, conversationId, '再跑一条命令', 'shell-budget');
      const result = await toolResultText(started.base, conversationId, 'SHELL_BUDGET_DONE');
      expect(result).toContain('shell 命令已达 40 条上限');
      expect(() => statSync(join(workspace, 'shell-budget.txt'))).toThrow();
    } finally {
      await stopHarness(started.harness);
      rmSync(runDir, { recursive: true, force: true });
      await setExecutionStatus(context.executionId, 'failed');
    }
  }, 240_000);
});
