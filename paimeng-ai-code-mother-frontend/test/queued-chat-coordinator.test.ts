import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerAction,
  createQueuedChatCoordinator,
  draftAfterReturnedRemoval,
  enqueueFingerprint,
  isUnknownEnqueueOutcome,
  queueItemLabel,
  resolveComposerShortcut,
  returnedItemDraft,
  shouldPollQueue,
  shouldStartInitialPrompt,
} from '../src/utils/queuedChatCoordinator.ts'
import type { MessageQueueState, QueueItem } from '../src/api/chatTypes.ts'

const queuedItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: 'queue-1',
  clientRequestId: 'request-1',
  message: '修改标题',
  mode: 'steer',
  status: 'queued',
  runId: null,
  ...overrides,
})

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

test('queue coordinator subscribes to the active run and dispose never cancels generation', async () => {
  const calls: string[] = []
  const activeState: MessageQueueState = {
    paused: false,
    items: [],
    activeRun: { runId: 'run-1', status: 'running' },
  }
  let published = activeState
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async (body) => queuedItem({ clientRequestId: body.clientRequestId }),
    getQueue: async () => activeState,
    remove: async () => undefined,
    resume: async () => activeState,
    cancel: async () => calls.push('cancel'),
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async (runId) => calls.push(`subscribe:${runId}`),
    changed: (state) => (published = state),
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  await coordinator.refresh()
  assert.equal(published.activeRun?.runId, 'run-1')
  assert.deepEqual(calls, ['subscribe:run-1'])
  coordinator.dispose()
  assert.equal(calls.includes('cancel'), false)
})

test('stopping only cancels the active run and leaves queued work in place', async () => {
  const calls: string[] = []
  const state: MessageQueueState = {
    paused: true,
    items: [queuedItem({ status: 'returned' })],
    activeRun: { runId: 'run-1', status: 'running' },
  }
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async () => queuedItem(),
    getQueue: async () => state,
    remove: async () => undefined,
    resume: async () => ({ ...state, paused: false }),
    cancel: async (runId) => calls.push(`cancel:${runId}`),
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  await coordinator.refresh()
  await coordinator.stop()
  assert.deepEqual(calls, ['cancel:run-1'])
  assert.equal(coordinator.getState().items.length, 1)
  coordinator.dispose()
})

test('a successful enqueue remains successful when the follow-up queue refresh fails', async () => {
  const errors: string[] = []
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async (body) => queuedItem({ clientRequestId: body.clientRequestId }),
    getQueue: async () => {
      throw new Error('queue read failed')
    },
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => undefined,
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: (error) => errors.push(error.message),
    pollMs: 60_000,
  })

  const item = await coordinator.enqueue({ appId: 7, message: '继续修改', mode: 'normal' })
  assert.equal(item.status, 'queued')
  assert.equal(coordinator.getState().items.length, 1)
  assert.deepEqual(errors, ['消息已接收，队列状态刷新失败'])
  coordinator.dispose()
})

test('retrying an unknown enqueue reuses its request id and original target run', async () => {
  const bodies: unknown[] = []
  let attempt = 0
  const activeState: MessageQueueState = {
    paused: false,
    items: [],
    activeRun: { runId: 'run-original', status: 'running' },
  }
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => `request-${++attempt}`,
    enqueue: async (body) => {
      bodies.push(body)
      if (bodies.length === 1) throw new Error('network timeout')
      return queuedItem({ clientRequestId: body.clientRequestId, runId: body.runId ?? null })
    },
    getQueue: async () => activeState,
    remove: async () => undefined,
    resume: async () => activeState,
    cancel: async () => undefined,
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => new Promise<void>(() => undefined),
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  await coordinator.refresh()
  await assert.rejects(
    coordinator.enqueue({ appId: 7, message: '先保留导航', mode: 'steer' }),
    /network timeout/,
  )
  await coordinator.enqueue({ appId: 7, message: '先保留导航', mode: 'steer' })

  assert.deepEqual(bodies[0], {
    appId: 7,
    message: '先保留导航',
    clientRequestId: 'request-1',
    mode: 'steer',
    runId: 'run-original',
  })
  assert.deepEqual(bodies[1], bodies[0])
  coordinator.dispose()
})

test('queue polling reconciles the old run before aborting its stream', async () => {
  const calls: string[] = []
  let queueRead = 0
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async () => queuedItem(),
    getQueue: async () => {
      queueRead += 1
      return queueRead === 1
        ? { paused: true, items: [], activeRun: { runId: 'run-old', status: 'running' } }
        : { paused: true, items: [queuedItem()], activeRun: null }
    },
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => undefined,
    reconcile: async (runId) => {
      calls.push(`reconcile:${runId}`)
      return { runId, status: 'completed', errorSummary: null }
    },
    subscribe: async (runId, _handlers, signal) => {
      calls.push(`subscribe:${runId}`)
      signal.addEventListener('abort', () => calls.push(`abort:${runId}`))
      await new Promise<void>(() => undefined)
    },
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: (result) => calls.push(`reconciled:${result.runId}:${result.status}`),
    error: () => undefined,
    pollMs: 60_000,
  })

  await coordinator.refresh()
  await coordinator.refresh()
  assert.deepEqual(calls, [
    'subscribe:run-old',
    'reconcile:run-old',
    'reconciled:run-old:completed',
    'abort:run-old',
  ])
  assert.equal(coordinator.getState().activeRun, null)
  coordinator.dispose()
})

test('a stale pre-enqueue GET cannot overwrite the item confirmed after POST', async () => {
  let resolveStale!: (state: MessageQueueState) => void
  const stale = new Promise<MessageQueueState>((resolve) => (resolveStale = resolve))
  let reads = 0
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async (body) => queuedItem({ clientRequestId: body.clientRequestId }),
    getQueue: async () => {
      reads += 1
      if (reads === 1) return stale
      return {
        paused: false,
        items: [queuedItem({ clientRequestId: 'request-1' })],
        activeRun: null,
      }
    },
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => undefined,
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  const staleRefresh = coordinator.refresh()
  await Promise.resolve()
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'normal' })
  assert.equal(reads, 2)
  resolveStale({ paused: false, items: [], activeRun: null })
  await staleRefresh
  assert.deepEqual(
    coordinator.getState().items.map((item) => item.clientRequestId),
    ['request-1'],
  )
  coordinator.dispose()
})

test('a failed returned removal keeps the queue item and never silently consumes it', async () => {
  const returned = queuedItem({ status: 'returned' })
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async () => returned,
    getQueue: async () => ({ paused: false, items: [returned], activeRun: null }),
    remove: async () => {
      throw new Error('network lost')
    },
    resume: async () => ({ paused: false, items: [returned], activeRun: null }),
    cancel: async () => undefined,
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  await coordinator.refresh()
  await assert.rejects(coordinator.remove(returned.id), /network lost/)
  assert.deepEqual(coordinator.getState().items, [returned])
  coordinator.dispose()
})

test('an unconfirmed initial queue keeps retrying at the configured interval', async () => {
  let reads = 0
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async () => queuedItem(),
    getQueue: async () => {
      reads += 1
      if (reads < 3) throw new Error('queue unavailable')
      return { paused: false, items: [], activeRun: null }
    },
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => undefined,
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 5,
  })

  await assert.rejects(coordinator.refresh(), /queue unavailable/)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(reads >= 3)
  assert.equal(coordinator.isQueueConfirmed(), true)
  coordinator.dispose()
})

test('an AppVO fallback run is subscribable and stoppable before queue reads succeed', async () => {
  const calls: string[] = []
  const coordinator = createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async () => queuedItem(),
    getQueue: async () => {
      throw new Error('queue unavailable')
    },
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async (runId) => calls.push(`cancel:${runId}`),
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async (runId) => calls.push(`subscribe:${runId}`),
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
  })

  coordinator.observeActiveRun({ runId: 'run-fallback', status: 'running' })
  assert.equal(coordinator.getState().activeRun?.runId, 'run-fallback')
  assert.deepEqual(calls, ['subscribe:run-fallback'])
  await coordinator.stop()
  assert.deepEqual(calls, ['subscribe:run-fallback', 'cancel:run-fallback'])
  coordinator.dispose()
})
