import { tool } from 'ai';
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { getWritable, getWorkflowMetadata } from 'workflow';
import { z } from 'zod';
import { AgentModelRef } from './model-ref';
import {
  echoToolStep,
  finishRunStep,
  openRunStep,
  persistTurnStep,
  prepareTurnStep,
} from './steps';

export type AgentWorkflowInput = {
  appId: string;
  generationId: string;
  conversationId: string;
};

const instructions = '你是应用生成助手。需要回显时调用 echo 工具，拿到结果后用一句话确认。';

/**
 * 一轮生成就是一次 WorkflowAgent 运行：模型调用与工具执行由 agent 各自放进 step，
 * 流写回 getWritable。默认引擎仍是 harness，本函数只由开关为 agent 的回显场景触发。
 */
export async function agentWorkflow(input: AgentWorkflowInput) {
  'use workflow';

  const runId = getWorkflowMetadata().workflowRunId;
  const writable = getWritable<ModelCallStreamPart>();
  await openRunStep({ runId, ...input });

  try {
    const turn = await prepareTurnStep({ runId, ...input });
    const agent = new WorkflowAgent({
      id: runId,
      model: new AgentModelRef(turn.slot),
      instructions,
      tools: {
        echo: tool({
          description: '回显一段文本，用于验证工具循环与 step 边界。',
          inputSchema: z.object({ text: z.string() }),
          execute: echoToolStep,
        }),
      },
    });
    const result = await agent.stream({ messages: turn.messages, writable });
    await persistTurnStep({
      runId,
      conversationId: input.conversationId,
      messages: result.messages,
      from: turn.messages.length,
    });
    await finishRunStep({ runId, status: 'completed' });
    return { runId, delivered: turn.delivered };
  } catch (error) {
    await finishRunStep({
      runId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
