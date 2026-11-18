import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMessageReplay,
  chatStreamEventType,
  mergeHistoryWithLiveMessages,
} from '../src/utils/chatStream.ts'
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

type HistoryItem = {
  id: number | null
  runId: string | null
  status: string
  message: ChatUIMessage
  key: string
  text: string
}

const assistant = (status = 'streaming', text = '', id: number | null = 2): HistoryItem => ({
  id,
  runId: 'run-1',
  status,
  key: id === null ? 'live-1' : `m-${id}`,
  text,
  message: {
    id: 'assistant:run-1',
    role: 'assistant',
    parts: text ? [{ type: 'text', text }] : [],
  },
})

test('late streaming history keeps the live snapshot and attaches its persisted id', () => {
  const live = assistant('streaming', '正在生成', null)
  const [merged] = mergeHistoryWithLiveMessages([assistant()], [live], new Set(['run-1']))
  assert.deepEqual(merged, { ...live, id: 2 })
})

test('history predating the assistant row keeps live content without duplicating user rows', () => {
  const user: HistoryItem = {
    ...assistant('completed', '需求', 1),
    message: { id: 'user:1', role: 'user', parts: [] },
  }
  const live = assistant('streaming', '正在生成', null)
  assert.deepEqual(mergeHistoryWithLiveMessages([user], [user, live], new Set(['run-1'])), [
    user,
    live,
  ])
})

test('persisted terminal history replaces live content, while stale streaming history cannot reopen a finished run', () => {
  const live = assistant('completed', '已完成', null)
  assert.deepEqual(mergeHistoryWithLiveMessages([assistant()], [live], new Set(['run-1'])), [
    { ...live, id: 2 },
  ])
  const terminal = assistant('completed', '已落库的最终内容')
  assert.deepEqual(mergeHistoryWithLiveMessages([terminal], [live], new Set(['run-1'])), [terminal])
})

test('history without a live subscription remains authoritative and preserves other runs', () => {
  const old = { ...assistant('completed', '上轮', 1), runId: 'run-0' }
  const current = assistant('streaming', '旧历史')
  const fresh = assistant('streaming', '新历史')
  assert.deepEqual(mergeHistoryWithLiveMessages([old, fresh], [current], new Set()), [old, fresh])
})
