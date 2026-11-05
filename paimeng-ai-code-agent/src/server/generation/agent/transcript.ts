import 'server-only';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db, now, type Transaction } from '../../infra/db';
import { agentConversations, agentMessages } from '../../infra/schema';

export type AgentMessageRole = 'system' | 'user' | 'assistant';

export async function ensureConversation(appId: string): Promise<bigint> {
  const app = BigInt(appId);
  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: agentConversations.id })
      .from(agentConversations)
      .where(eq(agentConversations.appId, app))
      .for('update')
      .limit(1);
    if (existing) return existing.id;
    const stamp = now();
    const [created] = await tx
      .insert(agentConversations)
      .values({ appId: app, lastSeq: 0, createTime: stamp, updateTime: stamp })
      .returning({ id: agentConversations.id });
    return created.id;
  });
}

export type AppendMessageInput = {
  conversationId: bigint;
  role: AgentMessageRole;
  parts: UIMessage['parts'];
  runId?: string | null;
  inputId?: string | null;
};

/** 在调用方的事务里分配 seq；输入投递要求消息写入与水位推进原子提交。 */
export async function appendMessageTx(
  tx: Transaction,
  input: AppendMessageInput,
): Promise<{ id: string; seq: number }> {
  const [conversation] = await tx
    .select({ id: agentConversations.id, lastSeq: agentConversations.lastSeq })
    .from(agentConversations)
    .where(eq(agentConversations.id, input.conversationId))
    .for('update');
  if (!conversation) throw new Error('会话不存在');
  const seq = conversation.lastSeq + 1;
  const stamp = now();
  const id = randomUUID();
  await tx.insert(agentMessages).values({
    id,
    conversationId: input.conversationId,
    runId: input.runId ?? null,
    seq,
    role: input.role,
    parts: input.parts,
    inputId: input.inputId ?? null,
    createTime: stamp,
    updateTime: stamp,
  });
  await tx
    .update(agentConversations)
    .set({ lastSeq: seq, updateTime: stamp })
    .where(eq(agentConversations.id, input.conversationId));
  return { id, seq };
}

export async function appendMessage(
  input: AppendMessageInput,
): Promise<{ id: string; seq: number }> {
  return db().transaction((tx) => appendMessageTx(tx, input));
}

export async function conversationOf(appId: string): Promise<bigint | null> {
  const [row] = await db()
    .select({ id: agentConversations.id })
    .from(agentConversations)
    .where(eq(agentConversations.appId, BigInt(appId)))
    .limit(1);
  return row?.id ?? null;
}

export async function loadMessages(conversationId: bigint): Promise<UIMessage[]> {
  const rows = await db()
    .select({
      id: agentMessages.id,
      role: agentMessages.role,
      parts: agentMessages.parts,
    })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.seq));
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: row.parts as UIMessage['parts'],
  }));
}
