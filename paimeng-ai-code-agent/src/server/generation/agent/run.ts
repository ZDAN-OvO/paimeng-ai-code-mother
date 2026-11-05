import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { db, now } from '../../infra/db';
import { generationInputs, generations } from '../../infra/schema';
import { agentWorkflow } from './loop';
import { ensureConversation } from './transcript';
import { assertAgentWorldEnv } from './world';

export type EchoRunReceipt = {
  runId: string;
  generationId: string;
  conversationId: string;
};

/**
 * PR-01 的回显场景：建 generation、会话与一条已受理输入，然后交给 workflow。
 * 真实提交路径（authority、预算、构建）在 PR-02 之后接入，这里只验证 step 边界。
 */
export async function startEchoRun(input: {
  appId: string;
  userId: string;
  prompt: string;
}): Promise<EchoRunReceipt> {
  assertAgentWorldEnv();
  const conversationId = await ensureConversation(input.appId);
  const generationId = randomUUID();
  const inputId = randomUUID();
  const stamp = now();
  await db()
    .insert(generations)
    .values({
      id: generationId,
      appId: BigInt(input.appId),
      userId: BigInt(input.userId),
      status: 'generating',
      createTime: stamp,
      updateTime: stamp,
    });
  await db()
    .insert(generationInputs)
    .values({
      id: inputId,
      appId: BigInt(input.appId),
      generationId,
      seq: 1,
      requestId: inputId,
      mode: 'start',
      message: input.prompt,
      status: 'accepted',
      createTime: stamp,
      updateTime: stamp,
    });
  const run = await start(agentWorkflow, [
    { appId: input.appId, generationId, conversationId: conversationId.toString() },
  ]);
  await db()
    .update(generationInputs)
    .set({ runId: run.runId, updateTime: now() })
    .where(eq(generationInputs.id, inputId));
  return { runId: run.runId, generationId, conversationId: conversationId.toString() };
}
