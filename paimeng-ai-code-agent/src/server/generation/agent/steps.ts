import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { deliverQueuedInputs, finishRun, openRun, type AgentRunInput } from './run-store';
import { agentModelSlot } from './model';
import { appendMessage, loadMessages } from './transcript';

export async function openRunStep(input: AgentRunInput) {
  'use step';
  await openRun(input);
  return { runId: input.runId };
}

/**
 * 投递已受理输入并把历史转成模型消息。模型槽位也在这里决定，因为配置只在 step 进程内可读。
 */
export async function prepareTurnStep(input: {
  runId: string;
  appId: string;
  generationId: string;
  conversationId: string;
}) {
  'use step';
  const conversationId = BigInt(input.conversationId);
  const delivered = await deliverQueuedInputs({
    runId: input.runId,
    appId: input.appId,
    generationId: input.generationId,
    conversationId,
  });
  const history = await loadMessages(conversationId);
  return {
    slot: agentModelSlot(),
    delivered,
    messages: await convertToModelMessages(history),
  };
}

export async function echoToolStep(input: { text: string }) {
  'use step';
  return { echoed: input.text };
}

/** 把本轮新增的模型消息落成 agent_message；tool 结果从同一批 tool-call 里补回入参。 */
export async function persistTurnStep(input: {
  runId: string;
  conversationId: string;
  messages: ModelMessage[];
  from: number;
}) {
  'use step';
  const conversationId = BigInt(input.conversationId);
  const inputs = new Map<string, unknown>();
  for (const message of input.messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') inputs.set(part.toolCallId, part.input);
    }
  }
  for (const message of input.messages.slice(input.from)) {
    const parts = modelMessageParts(message, inputs);
    if (parts.length === 0) continue;
    // 工具结果在会话里记到 assistant 名下，与前端消费的 UIMessage 形状一致。
    await appendMessage({
      conversationId,
      role: message.role === 'tool' ? 'assistant' : message.role,
      parts,
      runId: input.runId,
    });
  }
  return { written: input.messages.length - input.from };
}

/** 会话里存工具返回值本身；ToolResultOutput 的包装留给 convertToModelMessages 再生成。 */
function toolResultValue(output: unknown): unknown {
  if (typeof output !== 'object' || output === null) return output;
  const { type, value } = output as { type?: string; value?: unknown };
  return type === 'text' || type === 'json' || type === 'error-text' || type === 'error-json'
    ? value
    : output;
}

function modelMessageParts(
  message: ModelMessage,
  inputs: Map<string, unknown>,
): UIMessage['parts'] {
  if (message.role === 'assistant') {
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    const parts: UIMessage['parts'] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool-call') {
        parts.push({
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: 'input-available',
          input: part.input,
        });
      }
    }
    return parts;
  }
  if (message.role === 'tool') {
    return message.content.flatMap((part) =>
      part.type === 'tool-result'
        ? [
            {
              type: `tool-${part.toolName}`,
              toolCallId: part.toolCallId,
              state: 'output-available' as const,
              input: inputs.get(part.toolCallId),
              output: toolResultValue(part.output),
            },
          ]
        : [],
    );
  }
  return [];
}

export async function finishRunStep(input: {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  error?: string;
}) {
  'use step';
  await finishRun(input.runId, input.status, input.error);
  return { runId: input.runId };
}
