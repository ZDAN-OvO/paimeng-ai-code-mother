import { describe, expect, it } from 'vitest'
import type { TextStreamPart, ToolSet } from 'ai'
import { readModelStream } from '../src/agent/model-stream'

async function* stream(parts: unknown[]) {
  for (const part of parts) yield part as TextStreamPart<ToolSet>
}

const finish = {
  type: 'finish',
  finishReason: 'tool-calls',
  totalUsage: { inputTokens: 32, outputTokens: 80, outputTokenDetails: { reasoningTokens: 12 } },
}

describe('model stream consumption', () => {
  it('reports tool generation progress without exposing file content or reasoning', async () => {
    const progress: Record<string, unknown>[] = []
    const result = await readModelStream(
      stream([
        { type: 'reasoning-delta', text: 'private reasoning' },
        { type: 'tool-input-start', id: 'call', toolName: 'write' },
        { type: 'tool-input-delta', id: 'call', delta: 'private file content' },
        {
          type: 'tool-call',
          toolCallId: 'call',
          toolName: 'write',
          input: { path: 'index.html', content: 'ok' },
        },
        finish,
      ]),
      () => undefined,
      (payload) => progress.push(payload),
    )
    expect(result.toolCalls).toHaveLength(1)
    expect(result.metrics).toMatchObject({ inputTokens: 32, outputTokens: 80, reasoningTokens: 12 })
    expect(progress.some((payload) => payload.tool === 'write')).toBe(true)
    expect(JSON.stringify(progress)).not.toMatch(/private reasoning|private file content/)
  })

  it('propagates SDK error chunks instead of treating them as an empty successful turn', async () => {
    await expect(
      readModelStream(stream([{ type: 'error', error: new Error('gateway failed') }]), () => undefined),
    ).rejects.toThrow('gateway failed')
  })

  it('keeps invalid tool-call metadata and length finish reason for bounded recovery', async () => {
    const result = await readModelStream(
      stream([
        { type: 'tool-call', toolCallId: 'call', toolName: 'write', input: '{"content":"cut', invalid: true },
        { ...finish, finishReason: 'length' },
      ]),
      () => undefined,
    )
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls[0].invalid).toBe(true)
  })

  it('rejects a stream that disconnects without a finish event', async () => {
    await expect(
      readModelStream(stream([{ type: 'text-delta', text: 'unfinished' }]), () => undefined),
    ).rejects.toThrow('未返回完成状态')
  })

  it('does not swallow cancellation', async () => {
    await expect(readModelStream(stream([{ type: 'abort' }]), () => undefined)).rejects.toThrow('中止')
  })
})
