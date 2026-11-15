import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMessageReplay, chatStreamEventType } from '../src/utils/chatStream.ts'
import type { ChatUIMessage } from '../src/api/chatTypes.ts'

test('maps transient data chunks to the event names consumed by the chat page', () => {
  assert.equal(chatStreamEventType('data-model'), 'model-status')
  assert.equal(chatStreamEventType('data-preview'), 'preview-status')
  assert.equal(chatStreamEventType('data-run'), 'run-finished')
  assert.equal(chatStreamEventType('data-run-started'), 'run-started')
})

test('replaying a run replaces the same assistant snapshot instead of appending deltas', () => {
  type Item = { runId: string | null; message: ChatUIMessage; label: string }
  const create = (): Item => ({
    runId: null,
    message: { id: 'placeholder', role: 'assistant', parts: [] },
    label: 'assistant',
  })
  const first = applyMessageReplay<Item>(
    [],
    'run-1',
    { id: 'ignored', role: 'assistant', parts: [{ type: 'text', text: '处理中' }] },
    create,
  )
  const replayed = applyMessageReplay<Item>(
    first.items,
    'run-1',
    { id: 'ignored-again', role: 'assistant', parts: [{ type: 'text', text: '已完成' }] },
    create,
  )

  assert.equal(replayed.items.length, 1)
  assert.equal(replayed.item.message.id, 'assistant:run-1')
  assert.equal(replayed.item.label, 'assistant')
  assert.deepEqual(replayed.item.message.parts, [{ type: 'text', text: '已完成' }])
})
