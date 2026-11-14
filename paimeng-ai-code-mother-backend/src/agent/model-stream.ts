import type { TextStreamPart, ToolSet } from 'ai'

export interface ModelToolCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid?: boolean
}

export async function readModelStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  onDelta: (text: string) => void,
  onProgress: (payload: Record<string, unknown>) => void = () => undefined,
) {
  const startedAt = Date.now()
  let firstEventMs: number | null = null
  let inputBytes = 0
  let lastProgressAt = 0
  let activeTool: string | undefined
  let text = ''
  let finishReason: string | undefined
  let usage: Extract<TextStreamPart<ToolSet>, { type: 'finish' }>['totalUsage'] | undefined
  const toolCalls: ModelToolCall[] = []
  for await (const part of stream) {
    if (part.type === 'error') throw part.error
    if (part.type === 'abort') throw new Error('模型请求已中止')
    if (
      ['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call'].includes(
        part.type,
      )
    ) {
      firstEventMs ??= Date.now() - startedAt
    }
    if (part.type === 'text-delta') {
      text += part.text
      onDelta(part.text)
    } else if (part.type === 'tool-input-start') {
      activeTool = part.toolName
      onProgress({ status: 'streaming', tool: activeTool, inputBytes, elapsedMs: Date.now() - startedAt })
    } else if (part.type === 'tool-input-delta') {
      inputBytes += Buffer.byteLength(part.delta, 'utf8')
      if (Date.now() - lastProgressAt >= 1000) {
        onProgress({ status: 'streaming', tool: activeTool, inputBytes, elapsedMs: Date.now() - startedAt })
        lastProgressAt = Date.now()
      }
    } else if (part.type === 'tool-call') {
      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        invalid: part.invalid === true,
      })
    } else if (part.type === 'finish') {
      finishReason = part.finishReason
      usage = part.totalUsage
    }
  }
  if (!finishReason) throw new Error('模型流未返回完成状态，连接可能已中断')
  if (!['stop', 'tool-calls', 'length'].includes(finishReason)) {
    throw new Error(`模型未正常完成输出（${finishReason}）`)
  }
  return {
    text,
    toolCalls,
    finishReason,
    metrics: {
      elapsedMs: Date.now() - startedAt,
      firstEventMs,
      inputBytes,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
      finishReason,
      invalidToolCalls: toolCalls.filter((call) => call.invalid).length,
    },
  }
}
