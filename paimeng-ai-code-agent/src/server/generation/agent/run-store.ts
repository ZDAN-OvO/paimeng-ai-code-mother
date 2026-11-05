import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, now } from '../../infra/db';
import {
  agentRuns,
  generationInputs,
  generations,
  type AgentRunStatus,
  type InputStatus,
} from '../../infra/schema';
import { appendMessageTx } from './transcript';

/** 仍待投递的输入：接口已受理，还没有落成 agent_message。 */
const queuedStatuses: InputStatus[] = ['accepted', 'placed'];

export type AgentRunInput = {
  runId: string;
  appId: string;
  generationId: string;
  conversationId: string;
};

export async function openRun(input: AgentRunInput): Promise<void> {
  const stamp = now();
  await db()
    .insert(agentRuns)
    .values({
      runId: input.runId,
      appId: BigInt(input.appId),
      generationId: input.generationId,
      conversationId: BigInt(input.conversationId),
      status: 'running',
      createTime: stamp,
      updateTime: stamp,
    })
    .onConflictDoNothing();
}

export async function finishRun(
  runId: string,
  status: Exclude<AgentRunStatus, 'running'>,
  error?: string,
): Promise<void> {
  const stamp = now();
  await db().transaction(async (tx) => {
    const [run] = await tx
      .select({ generationId: agentRuns.generationId })
      .from(agentRuns)
      .where(eq(agentRuns.runId, runId))
      .limit(1);
    await tx
      .update(agentRuns)
      .set({ status, error: error ?? null, finishedAt: stamp, updateTime: stamp })
      .where(eq(agentRuns.runId, runId));
    if (!run) return;
    await tx
      .update(generations)
      .set({
        status: status === 'completed' ? 'ready' : status,
        error: error ?? null,
        updateTime: stamp,
      })
      .where(eq(generations.id, run.generationId));
  });
}

export type AgentRunView = {
  runId: string;
  appId: string;
  generationId: string;
  status: AgentRunStatus;
  error: string | null;
  createTime: string;
  updateTime: string;
  finishedAt: string | null;
};

export async function getAgentRun(runId: string): Promise<AgentRunView | null> {
  const [run] = await db().select().from(agentRuns).where(eq(agentRuns.runId, runId)).limit(1);
  if (!run) return null;
  return {
    runId: run.runId,
    appId: run.appId.toString(),
    generationId: run.generationId,
    status: run.status,
    error: run.error,
    createTime: run.createTime,
    updateTime: run.updateTime,
    finishedAt: run.finishedAt,
  };
}

/**
 * 把已受理的输入按 seq 追加为用户消息并推进水位。消息写入与状态更新同一事务，
 * 崩溃重放时要么都发生、要么都不发生（D6）。
 */
export async function deliverQueuedInputs(input: {
  runId: string;
  appId: string;
  generationId: string;
  conversationId: bigint;
}): Promise<number> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(generationInputs)
      .where(
        and(
          eq(generationInputs.appId, BigInt(input.appId)),
          // seq 只在一代 generation 内唯一，必须按本轮范围投递，不能把上一轮的残留带进来。
          eq(generationInputs.generationId, input.generationId),
          inArray(generationInputs.status, queuedStatuses),
        ),
      )
      .orderBy(asc(generationInputs.seq))
      .for('update');
    for (const row of rows) {
      const message = await appendMessageTx(tx, {
        conversationId: input.conversationId,
        role: 'user',
        parts: [{ type: 'text', text: row.message }],
        runId: input.runId,
        inputId: row.id,
      });
      await tx
        .update(generationInputs)
        .set({
          status: 'resolved',
          messageId: message.id,
          runId: input.runId,
          updateTime: now(),
        })
        .where(eq(generationInputs.id, row.id));
    }
    return rows.length;
  });
}
