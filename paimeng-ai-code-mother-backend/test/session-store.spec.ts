import { describe, expect, it } from 'vitest'
import { streamText, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import type { SessionEntryRow } from '../src/db/schema'
import { SessionStoreService } from '../src/agent/session-store.service'

const store = new SessionStoreService({} as never)

function entry(entryType: string, payload: object, runId = 'run-1'): SessionEntryRow {
  return {
    id: 1,
    conversationId: 1,
    runId,
    seq: 1,
    entryType,
    payload,
    createdAt: new Date(0),
  }
}

function toolParts(messages: ModelMessage[], type: 'tool-call' | 'tool-result') {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === type) : [],
  )
}

describe('session model history', () => {
  it('sends paired valid history through the real Responses adapter without rejected arguments', async () => {
    const rows = [
      entry('user', { text: '保留用户需求' }),
      entry('assistant', {
        text: '',
        toolCalls: [
          { toolCallId: 'bad', toolName: 'write', input: 'rejected raw arguments', invalid: true },
          { toolCallId: 'good', toolName: 'ls', input: {} },
        ],
      }),
      entry('tool', { toolCallId: 'bad', toolName: 'write', output: 'rejected raw result' }),
      entry('tool', { toolCallId: 'good', toolName: 'ls', output: 'kept result' }),
    ]
    const events = [
      { type: 'response.created', response: { id: 'response', created_at: 0, model: 'test' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message' } },
      { type: 'response.output_text.delta', item_id: 'message', delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message' } },
      { type: 'response.completed', response: {} },
    ]
    let wireInput: Array<Record<string, unknown>> = []
    const provider = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        wireInput = JSON.parse(String(init?.body)).input
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const result = streamText({
      model: provider.responses('test-model'),
      messages: store.toModelMessages(rows, 50 * 1024),
      maxRetries: 0,
    })
    expect(await result.text).toBe('ok')
    expect(wireInput.filter((item) => item.type === 'function_call')).toEqual([
      { type: 'function_call', call_id: 'good', name: 'ls', arguments: '{}' },
    ])
    expect(wireInput.filter((item) => item.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'good', output: 'kept result' },
    ])
    expect(JSON.stringify(wireInput)).not.toContain('rejected raw')
    expect(JSON.stringify(wireInput)).toContain('保留用户需求')
  })

  it.each([
    { label: 'legacy truncated string', input: '{"content":"' + '坏参数'.repeat(20_000) },
    { label: 'legacy JSON string', input: JSON.stringify({ path: 'index.html', content: 'old' }) },
    { label: 'SDK invalid object', input: { content: '坏参数'.repeat(20_000) }, invalid: true },
    { label: 'SDK invalid string', input: '坏参数'.repeat(20_000), invalid: true },
    { label: 'null', input: null },
    { label: 'array', input: [] },
  ])('replaces $label and its result without changing audit rows', ({ input, ...flags }) => {
    const rows = [
      entry('user', { text: '保留用户需求' }),
      entry('assistant', {
        text: '保留助手说明',
        toolCalls: [{ toolCallId: 'bad', toolName: 'write', input, invalid: flags.invalid }],
      }),
      entry('tool', { toolCallId: 'bad', toolName: 'write', output: '坏结果'.repeat(20_000) }),
    ]
    const original = structuredClone(rows)
    const messages = store.toModelMessages(rows, 50 * 1024)
    const serialized = JSON.stringify(messages)

    expect(serialized).toContain('保留用户需求')
    expect(serialized).toContain('保留助手说明')
    expect(serialized).toContain('write')
    expect(serialized).toMatch(/参数.*(无效|截断)/)
    expect(serialized).not.toContain('坏参数')
    expect(serialized).not.toContain('坏结果')
    expect(serialized.length).toBeLessThan(1000)
    expect(toolParts(messages, 'tool-call')).toEqual([])
    expect(toolParts(messages, 'tool-result')).toEqual([])
    expect(rows).toEqual(original)
  })

  it('retains valid calls and results in a mixed assistant turn and across runs', () => {
    const validInput = { path: 'index.html', content: '有效内容'.repeat(15_000) }
    const rows = [
      entry('assistant', {
        text: '',
        toolCalls: [
          { toolCallId: 'reused', toolName: 'write', input: 'broken' },
          { toolCallId: 'valid', toolName: 'write', input: validInput },
        ],
      }),
      entry('tool', { toolCallId: 'reused', toolName: 'write', output: 'invalid result' }),
      entry('tool', { toolCallId: 'valid', toolName: 'write', output: 'valid result' }),
      entry('system_note', { text: '保留系统指令' }),
      entry('user', { text: '继续修改' }, 'run-2'),
      entry(
        'assistant',
        {
          text: '第二轮说明',
          toolCalls: [{ toolCallId: 'reused', toolName: 'ls', input: {}, invalid: false }],
        },
        'run-2',
      ),
      entry('tool', { toolCallId: 'reused', toolName: 'ls', output: 'valid reused result' }, 'run-2'),
    ]

    const messages = store.toModelMessages(rows, 50 * 1024)
    expect(toolParts(messages, 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'valid', toolName: 'write', input: validInput },
      { type: 'tool-call', toolCallId: 'reused', toolName: 'ls', input: {} },
    ])
    expect(toolParts(messages, 'tool-result')).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'valid',
        toolName: 'write',
        output: { type: 'text', value: 'valid result' },
      },
      {
        type: 'tool-result',
        toolCallId: 'reused',
        toolName: 'ls',
        output: { type: 'text', value: 'valid reused result' },
      },
    ])
    expect(JSON.stringify(messages)).toContain('继续修改')
    expect(JSON.stringify(messages)).toContain('保留系统指令')
  })

  it('leaves no dangling call when an invalid call has no result', () => {
    const rows = [
      entry('assistant', {
        text: '',
        toolCalls: [{ toolCallId: 'pending', toolName: 'write', input: 'truncated' }],
      }),
    ]
    const messages = store.toModelMessages(rows, 50 * 1024)
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toMatch(/参数.*(无效|截断)/)
    expect(toolParts(messages, 'tool-call')).toEqual([])
  })
})
