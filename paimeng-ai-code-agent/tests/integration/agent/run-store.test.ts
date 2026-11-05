import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { apps, generationInputs, generations, users } from '@/server/infra/schema';
import {
  deliverQueuedInputs,
  finishRun,
  getAgentRun,
  openRun,
} from '@/server/generation/agent/run-store';
import {
  appendMessage,
  conversationOf,
  ensureConversation,
  loadMessages,
} from '@/server/generation/agent/transcript';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const created: bigint[] = [];
let userId: bigint;

async function createApp(): Promise<string> {
  const id = await nextSnowflakeId();
  const stamp = now();
  await db().insert(apps).values({
    id,
    initPrompt: 'agent test',
    codeGenType: 'html',
    userId,
    createTime: stamp,
    updateTime: stamp,
  });
  created.push(id);
  return id.toString();
}

async function createGeneration(appId: string): Promise<string> {
  const id = randomUUID();
  const stamp = now();
  await db()
    .insert(generations)
    .values({
      id,
      appId: BigInt(appId),
      userId,
      status: 'generating',
      createTime: stamp,
      updateTime: stamp,
    });
  return id;
}

async function createInput(appId: string, generationId: string, seq: number, message: string) {
  const id = randomUUID();
  const stamp = now();
  await db()
    .insert(generationInputs)
    .values({
      id,
      appId: BigInt(appId),
      generationId,
      seq,
      requestId: id,
      mode: 'start',
      message,
      status: 'accepted',
      createTime: stamp,
      updateTime: stamp,
    });
  return id;
}

beforeAll(async () => {
  userId = await nextSnowflakeId();
  const stamp = now();
  await db()
    .insert(users)
    .values({
      id: userId,
      userAccount: `agent-test-${userId}`,
      userPassword: 'scrypt$test',
      createTime: stamp,
      updateTime: stamp,
    });
});

afterAll(async () => {
  for (const appId of created) {
    await db().delete(generations).where(eq(generations.appId, appId));
    await db().delete(apps).where(eq(apps.id, appId));
  }
  await db().delete(users).where(eq(users.id, userId));
  await getPool().end();
});

describe('转录', () => {
  it('会话按 app 唯一，消息按 seq 递增投影', async () => {
    const appId = await createApp();
    const conversationId = await ensureConversation(appId);
    expect(await ensureConversation(appId)).toBe(conversationId);
    expect(await conversationOf(appId)).toBe(conversationId);

    const first = await appendMessage({
      conversationId,
      role: 'user',
      parts: [{ type: 'text', text: '一' }],
    });
    const second = await appendMessage({
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', text: '二' }],
    });
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const messages = await loadMessages(conversationId);
    expect(messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});

describe('输入水位', () => {
  it('按 seq 投递并原子推进到 resolved，重复投递不重复写', async () => {
    const appId = await createApp();
    const generationId = await createGeneration(appId);
    const conversationId = await ensureConversation(appId);
    const first = await createInput(appId, generationId, 1, '第一条');
    const second = await createInput(appId, generationId, 2, '第二条');

    const delivered = await deliverQueuedInputs({
      runId: 'wrun_test_delivery',
      appId,
      generationId,
      conversationId,
    });
    expect(delivered).toBe(2);

    const rows = (
      await db()
        .select()
        .from(generationInputs)
        .where(eq(generationInputs.appId, BigInt(appId)))
    ).sort((left, right) => left.seq - right.seq);
    expect(rows.every((row) => row.status === 'resolved')).toBe(true);
    expect(rows.every((row) => row.messageId !== null && row.runId === 'wrun_test_delivery')).toBe(
      true,
    );

    const messages = await loadMessages(conversationId);
    expect(messages.map((message) => message.id)).toEqual(rows.map((row) => row.messageId));

    expect(
      await deliverQueuedInputs({
        runId: 'wrun_test_delivery',
        appId,
        generationId,
        conversationId,
      }),
    ).toBe(0);
    expect(await loadMessages(conversationId)).toHaveLength(2);
    expect(rows[0].id).toBe(first);
    expect(rows[1].id).toBe(second);
  });
});

describe('运行记录', () => {
  it('创建运行并在结束时同步 generation 状态', async () => {
    const appId = await createApp();
    const generationId = await createGeneration(appId);
    const conversationId = await ensureConversation(appId);
    await openRun({
      runId: 'wrun_test_open',
      appId,
      generationId,
      conversationId: `${conversationId}`,
    });

    const running = await getAgentRun('wrun_test_open');
    expect(running?.status).toBe('running');
    expect(running?.appId).toBe(appId);

    await finishRun('wrun_test_open', 'completed');
    expect((await getAgentRun('wrun_test_open'))?.status).toBe('completed');
    const [generation] = await db()
      .select()
      .from(generations)
      .where(eq(generations.id, generationId));
    expect(generation.status).toBe('ready');
  });
});
