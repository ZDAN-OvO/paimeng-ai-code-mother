import { describe, expect, it } from 'vitest'
import {
  UIMessageAccumulator,
  UIMessageEmitter,
  messageText,
  replayMessageChunks,
  type AppUIMessageChunk,
} from '../src/conversations/ui-message'

describe('UI message stream', () => {
  it('keeps text, tools, plans and later text in emission order', async () => {
    const chunks: AppUIMessageChunk[] = []
    const accumulator = new UIMessageAccumulator('run-1')
    const emitter = new UIMessageEmitter('run-1', (chunk) => {
      chunks.push(chunk)
      accumulator.write(chunk)
    })
    emitter.start()
    emitter.emit('text-delta', { text: '先检查目录。' })
    emitter.emit('tool-started', { tool: 'ls', toolCallId: 'ls', input: { path: '.' } })
    emitter.emit('tool-finished', { tool: 'ls', toolCallId: 'ls', ok: true })
    emitter.emit('text-delta', { text: '现在实现。' })
    emitter.emit('plan-updated', {
      revision: 1,
      steps: [{ id: '1', title: '实现', status: 'in_progress' }],
    })
    emitter.emit('tool-started', {
      tool: 'write',
      toolCallId: 'write',
      input: { path: 'index.html', bytes: 12 },
    })
    emitter.emit('tool-finished', { tool: 'write', toolCallId: 'write', ok: true })
    emitter.emit('text-delta', { text: '完成。' })
    emitter.finish({ status: 'completed' })
    const message = await accumulator.close()

    expect(message.parts.map((part) => part.type)).toEqual([
      'text',
      'dynamic-tool',
      'text',
      'data-plan',
      'dynamic-tool',
      'text',
    ])
    expect(messageText(message)).toBe('先检查目录。现在实现。完成。')
    expect(chunks.filter((chunk) => chunk.type === 'data-run')).toHaveLength(1)
  })

  it('updates a tool in place when its result arrives later', async () => {
    const accumulator = new UIMessageAccumulator('run-2')
    const emitter = new UIMessageEmitter('run-2', (chunk) => accumulator.write(chunk))
    emitter.start()
    emitter.emit('tool-started', { tool: 'read', toolCallId: 'read', input: { path: 'a.ts' } })
    emitter.emit('text-delta', { text: '继续' })
    emitter.emit('tool-finished', { tool: 'read', toolCallId: 'read', ok: true })
    emitter.finish({ status: 'completed' })
    const message = await accumulator.close()

    expect(message.parts.map((part) => part.type)).toEqual(['dynamic-tool', 'text'])
    expect(message.parts[0]).toMatchObject({ type: 'dynamic-tool', state: 'output-available' })
  })

  it('replays a persisted message in order with its original id', async () => {
    const accumulator = new UIMessageAccumulator('run-3')
    const emitter = new UIMessageEmitter('run-3', (chunk) => accumulator.write(chunk))
    emitter.start()
    emitter.emit('text-delta', { text: '完成。' })
    emitter.emit('tool-started', { tool: 'write', toolCallId: 'write', input: { path: 'a.html' } })
    emitter.emit('tool-finished', { tool: 'write', toolCallId: 'write', ok: true })
    emitter.finish({ status: 'completed' })
    const message = await accumulator.close()

    const chunks = replayMessageChunks(message)
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'assistant:run-3' })
    expect(chunks.map((chunk) => chunk.type)).toContain('tool-output-available')
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1)
  })
})
