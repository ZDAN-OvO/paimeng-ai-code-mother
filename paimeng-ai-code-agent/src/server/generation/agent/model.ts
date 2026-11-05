import 'server-only';
import type { LanguageModel } from 'ai';
import { setAgentModelResolver, type AgentModelSlot } from './model-ref';
import { MockLanguageModelV4 } from 'ai/test';
import { getConfig } from '../../infra/config';
import { modelRegistry } from '../../models/registry';

const fixtureUsage = () => ({
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
});

/**
 * 夹具模型只用于 PR-01 的回显场景：第一次调用返回 echo 工具，拿到工具结果后回文本。
 * 与 AI_MODE=fixture 同义，生产环境仍由配置校验拒绝。
 * WorkflowAgent 走 doStream，所以两条路径都要给；只给 doGenerate 会报 Not implemented。
 */
export function fixtureAgentModel(): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'fixture',
    modelId: 'agent-echo',
    doStream: async ({ prompt }) => {
      const answered = prompt.some((message) => message.role === 'tool');
      const parts = answered
        ? [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 'fixture-text' },
            { type: 'text-delta' as const, id: 'fixture-text', delta: 'echo: hello' },
            { type: 'text-end' as const, id: 'fixture-text' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: fixtureUsage(),
            },
          ]
        : [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'tool-input-start' as const, id: 'echo-1', toolName: 'echo' },
            {
              type: 'tool-input-delta' as const,
              id: 'echo-1',
              delta: JSON.stringify({ text: 'hello' }),
            },
            { type: 'tool-input-end' as const, id: 'echo-1' },
            {
              type: 'tool-call' as const,
              toolCallId: 'echo-1',
              toolName: 'echo',
              input: JSON.stringify({ text: 'hello' }),
            },
            {
              type: 'finish' as const,
              finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
              usage: fixtureUsage(),
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
    doGenerate: async ({ prompt }) => {
      const answered = prompt.some((message) => message.role === 'tool');
      if (!answered)
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'echo-1',
              toolName: 'echo',
              input: JSON.stringify({ text: 'hello' }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: fixtureUsage(),
          warnings: [],
        };
      return {
        content: [{ type: 'text' as const, text: 'echo: hello' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: fixtureUsage(),
        warnings: [],
      };
    },
  });
}

/** 产品配置里的 codegen.default 槽位；不保留 pi-ai 路径。 */
export async function resolveAgentModel(
  slot: AgentModelSlot = 'codegen.default',
): Promise<LanguageModel> {
  if (slot === 'fixture') return fixtureAgentModel();
  return modelRegistry().resolveModel(slot);
}

export type { AgentModelSlot } from './model-ref';

export function agentModelSlot(): AgentModelSlot {
  return getConfig().aiMode === 'fixture' ? 'fixture' : 'codegen.default';
}

// 只在 step 进程执行；workflow VM 里没有这一步，也就不需要模型解析。
setAgentModelResolver(async (slot) => {
  const model = await resolveAgentModel(slot);
  if (typeof model === 'string' || model.specificationVersion !== 'v4')
    throw new Error(`模型槽位 ${slot} 没有解析到 v4 模型`);
  return model;
});
