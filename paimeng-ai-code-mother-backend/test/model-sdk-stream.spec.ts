import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { readModelStream } from '../src/agent/model-stream'

function modelFor(events: unknown[]) {
  return createOpenAI({
    apiKey: 'test',
    fetch: async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  }).responses('test')
}

const tools = { write: tool({ inputSchema: z.object({ path: z.string(), content: z.string() }) }) }

function toolEvents(input: string, truncated = false) {
  const item = {
    type: 'function_call',
    id: 'fc',
    call_id: 'call',
    name: 'write',
    arguments: input,
    status: truncated ? 'incomplete' : 'completed',
  }
  return [
    { type: 'response.created', response: { id: 'response', created_at: 1, model: 'test' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 0, delta: input },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: truncated ? 'response.incomplete' : 'response.completed',
      response: {
        incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
        usage: { input_tokens: 120, output_tokens: 8192, output_tokens_details: { reasoning_tokens: 3 } },
      },
    },
  ]
}

describe('Responses protocol through the real AI SDK', () => {
  it('recognizes truncated JSON and usage instead of executing a string as tool arguments', async () => {
    const result = streamText({
      model: modelFor(toolEvents('{"path":"styles.css","content":"cut', true)),
      prompt: 'build',
      tools,
      maxRetries: 0,
      onError: () => undefined,
    })
    const turn = await readModelStream(result.fullStream, () => undefined)
    expect(turn.finishReason).toBe('length')
    expect(turn.toolCalls[0]).toMatchObject({ invalid: true, toolName: 'write' })
    expect(turn.metrics).toMatchObject({ inputTokens: 120, outputTokens: 8192, reasoningTokens: 3 })
  })

  it('keeps valid tool arguments as objects and emits safe progress before completion', async () => {
    const progress: Record<string, unknown>[] = []
    const input = { path: 'index.html', content: '<h1>hello</h1>' }
    const result = streamText({
      model: modelFor(toolEvents(JSON.stringify(input))),
      prompt: 'build',
      tools,
      maxRetries: 0,
      onError: () => undefined,
    })
    const turn = await readModelStream(
      result.fullStream,
      () => undefined,
      (value) => progress.push(value),
    )
    expect(turn.toolCalls[0]).toMatchObject({ invalid: false, input })
    expect(progress.some((value) => value.tool === 'write')).toBe(true)
    expect(JSON.stringify(progress)).not.toContain('<h1>')
  })

  it('surfaces a response.failed error as a failure rather than a no-code turn', async () => {
    const result = streamText({
      model: modelFor([
        {
          type: 'response.failed',
          sequence_number: 1,
          response: { error: { code: 'server_error', message: 'gateway failed' } },
        },
      ]),
      prompt: 'build',
      tools,
      maxRetries: 0,
      onError: () => undefined,
    })
    await expect(readModelStream(result.fullStream, () => undefined)).rejects.toThrow('gateway failed')
  })
})
