import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerAction,
  draftAfterReturnedRemoval,
  enqueueFingerprint,
  isUnknownEnqueueOutcome,
  queueItemLabel,
  resolveComposerShortcut,
  returnedItemDraft,
  shouldPollQueue,
  shouldStartInitialPrompt,
} from '../src/utils/queuedChatCoordinator.ts'
import { queuedItem } from './support/queue.ts'

const keyboard = (overrides: Partial<Record<string, unknown>> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...overrides,
})

test('Enter uses the selected mode and Alt+Enter sends with the opposite mode', () => {
  assert.deepEqual(resolveComposerShortcut(keyboard(), '继续修改', 'steer'), {
    type: 'submit',
    mode: 'steer',
  })
  assert.deepEqual(resolveComposerShortcut(keyboard({ altKey: true }), '继续修改', 'steer'), {
    type: 'submit',
    mode: 'normal',
  })
  assert.deepEqual(resolveComposerShortcut(keyboard({ altKey: true }), '继续修改', 'normal'), {
    type: 'submit',
    mode: 'steer',
  })
})

test('Shift+Enter keeps a newline and IME or empty Enter never submits or stops', () => {
  assert.deepEqual(resolveComposerShortcut(keyboard({ shiftKey: true }), '继续修改', 'steer'), {
    type: 'newline',
  })
  assert.deepEqual(resolveComposerShortcut(keyboard({ isComposing: true }), '继续修改', 'steer'), {
    type: 'none',
  })
  assert.deepEqual(resolveComposerShortcut(keyboard({ keyCode: 229 }), '继续修改', 'steer'), {
    type: 'none',
  })
  assert.deepEqual(resolveComposerShortcut(keyboard(), '   ', 'steer'), { type: 'none' })
  assert.equal(composerAction('   ', true), 'stop')
})

test('returned messages restore only into an empty composer draft', () => {
  const returned = queuedItem({ status: 'returned' })
  assert.equal(returnedItemDraft('', returned), '修改标题')
  assert.equal(returnedItemDraft('当前草稿', returned), null)
  assert.equal(returnedItemDraft(' \n\t', returned), '修改标题')
  assert.equal(returnedItemDraft('\n', returned), '修改标题')
  assert.equal(returnedItemDraft('', queuedItem()), null)
  assert.equal(queueItemLabel(returned), '已退回，可恢复草稿')
  assert.equal(queueItemLabel(queuedItem()), '插话发送 · 等待插入当前轮次')
  assert.equal(
    queueItemLabel(queuedItem({ mode: 'normal', status: 'claimed' })),
    '普通消息 · 即将发送',
  )
})

test('returned removal restores the draft only when concurrent editing did not occur', () => {
  assert.deepEqual(draftAfterReturnedRemoval('', '退回的消息', '', false), {
    draft: '退回的消息',
    retainLocal: false,
  })
  assert.deepEqual(draftAfterReturnedRemoval('', '退回的消息', '用户新内容', true), {
    draft: null,
    retainLocal: true,
  })
  assert.deepEqual(draftAfterReturnedRemoval('\n', '退回的消息', '用户新内容', false), {
    draft: null,
    retainLocal: true,
  })
})

test('active runs keep polling while paused, but paused queues without a run do not', () => {
  const queued = queuedItem()
  assert.equal(
    shouldPollQueue({
      paused: true,
      items: [],
      activeRun: { runId: 'run-1', status: 'cancelling' },
    }),
    true,
  )
  assert.equal(shouldPollQueue({ paused: true, items: [queued], activeRun: null }), false)
  assert.equal(shouldPollQueue({ paused: false, items: [queued], activeRun: null }), true)
})

test('only an unknown enqueue outcome retains the idempotency attempt', () => {
  assert.equal(isUnknownEnqueueOutcome(new Error('network timeout')), true)
  assert.equal(isUnknownEnqueueOutcome({ response: { status: 409 } }), false)
  assert.equal(isUnknownEnqueueOutcome({ knownOutcome: true }), false)
  assert.equal(enqueueFingerprint('修改标题', 'steer'), 'steer\u0000修改标题')
})

test('initial prompt waits for a confirmed, empty, idle queue and runs only once', () => {
  const ready = {
    pending: true,
    started: false,
    initialized: true,
    historyLoading: false,
    historyConfirmed: true,
    queueConfirmed: true,
    messageCount: 0,
    paused: false,
    activeRun: null,
    queueItemCount: 0,
    initPrompt: '创建首页',
  }
  assert.equal(shouldStartInitialPrompt(ready), true)
  assert.equal(shouldStartInitialPrompt({ ...ready, queueConfirmed: false }), false)
  assert.equal(shouldStartInitialPrompt({ ...ready, started: true }), false)
  assert.equal(shouldStartInitialPrompt({ ...ready, historyLoading: true }), false)
  assert.equal(shouldStartInitialPrompt({ ...ready, historyConfirmed: false }), false)
  assert.equal(
    shouldStartInitialPrompt({ ...ready, activeRun: { runId: 'run-1', status: 'running' } }),
    false,
  )
  assert.equal(shouldStartInitialPrompt({ ...ready, queueItemCount: 1 }), false)
})

test('server failures and incomplete responses are uncertain even with a business envelope', () => {
  for (const error of [
    { response: { status: 500 } },
    { response: { status: 503, data: { code: 50300 } } },
    { response: { status: 200, data: { code: 50000 } } },
    { response: { status: 500, data: { code: 40900 } }, knownOutcome: true },
    { response: { status: 408 } },
    { response: { status: 200, data: { code: 0, data: null } } },
  ]) {
    assert.equal(isUnknownEnqueueOutcome(error), true, JSON.stringify(error))
  }
  assert.equal(isUnknownEnqueueOutcome({ response: { status: 200, data: { code: 40900 } } }), false)
})
