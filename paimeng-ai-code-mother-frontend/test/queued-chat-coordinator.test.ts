import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as Vue from 'vue'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
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
import type { QueuedChatDependencies } from '../src/utils/queuedChatCoordinator.ts'

const coordinatorFixture = (overrides: Partial<QueuedChatDependencies> = {}) =>
  createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async (body) => queuedItem({ mode: body.mode, clientRequestId: body.clientRequestId }),
    getQueue: async () => ({ paused: false, items: [], activeRun: null }),
    findRunByRequest: async () => {
      throw new Error('run status unavailable')
    },
    findQueueItemByRequest: async () => null,
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => assert.fail('disconnecting must not cancel the run'),
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
    ...overrides,
  })

const queuedItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: 'queue-1',
  clientRequestId: 'request-1',
  message: '修改标题',
  mode: 'steer',
  status: 'queued',
  runId: null,
  ...overrides,
})

test('a pending recovery does not delay publishing, stopping, or observing later queue snapshots', async (context) => {
  const item = queuedItem({ mode: 'normal' })
  let recoveryResolve!: (item: QueueItem) => void
  const recovery = new Promise<QueueItem>((resolve) => (recoveryResolve = resolve))
  let activeRunId = 'run-original'
  let first = true
  const subscriptions: string[] = []
  const cancelled: string[] = []
  let lookups = 0
  const coordinator = coordinatorFixture({
    getQueue: async () => ({
      paused: false,
      activeRun: { runId: activeRunId, status: 'running' },
      items: first ? [item] : [],
    }),
    findQueueItemByRequest: async () => {
      lookups += 1
      return recovery
    },
    cancel: async (runId) => {
      cancelled.push(runId)
    },
    subscribe: async (runId) => {
      subscriptions.push(runId)
      await new Promise<void>(() => undefined)
    },
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  first = false
  activeRunId = 'run-next'
  await coordinator.refresh()
  assert.equal(coordinator.getState().activeRun?.runId, 'run-next')
  assert.deepEqual(subscriptions, ['run-original', 'run-next'])
  assert.equal(await coordinator.stop(), true)
  assert.deepEqual(cancelled, ['run-next'])
  activeRunId = 'run-later'
  await coordinator.refresh()
  assert.equal(coordinator.getState().activeRun?.runId, 'run-later')
  assert.equal(lookups, 1)
  recoveryResolve({ ...item, status: 'started', runId: 'run-obsolete' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getState().activeRun?.runId, 'run-later')
})

test('a normal item removed in another tab cannot block a successor subscription', async (context) => {
  const item = queuedItem({ mode: 'normal' })
  let removed = false
  const subscriptions: string[] = []
  let lookups = 0
  const coordinator = coordinatorFixture({
    getQueue: async () => ({
      paused: false,
      items: removed ? [] : [item],
      activeRun: { runId: removed ? 'run-next' : 'run-original', status: 'running' },
    }),
    findQueueItemByRequest: async () => {
      lookups += 1
      return { ...item, status: 'removed' }
    },
    findRunByRequest: async () => assert.fail('removed messages have no run'),
    subscribe: async (runId) => {
      subscriptions.push(runId)
      await new Promise<void>(() => undefined)
    },
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  removed = true
  await coordinator.refresh()
  await coordinator.refresh()
  assert.deepEqual(subscriptions, ['run-original', 'run-next'])
  assert.deepEqual(coordinator.getState().items, [])
  assert.equal(lookups, 1)
})

test('a lost removal response is recovered from the stored removal marker', async (context) => {
  const item = queuedItem({ mode: 'normal' })
  let removed = false
  const coordinator = coordinatorFixture({
    getQueue: async () => ({ paused: true, activeRun: null, items: removed ? [] : [item] }),
    remove: async () => {
      removed = true
      throw new Error('reply lost after removal')
    },
    findQueueItemByRequest: async () => ({ ...item, status: 'removed' }),
    findRunByRequest: async () => assert.fail('removed messages have no run'),
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  await assert.rejects(coordinator.remove(item.id), /reply lost/)
  await coordinator.refresh()
  assert.deepEqual(coordinator.getState(), { paused: true, activeRun: null, items: [] })
})

test('an individual recovery outage still publishes the latest queue and subscribes its run', async (context) => {
  const item = queuedItem({ mode: 'normal' })
  let first = true
  const subscriptions: string[] = []
  const coordinator = coordinatorFixture({
    getQueue: async () => ({
      paused: false,
      activeRun: first ? null : { runId: 'run-next', status: 'running' },
      items: first ? [item] : [],
    }),
    findQueueItemByRequest: async () => {
      throw new Error('item recovery unavailable')
    },
    subscribe: async (runId) => {
      subscriptions.push(runId)
      await new Promise<void>(() => undefined)
    },
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  first = false
  await coordinator.refresh()
  assert.equal(coordinator.getState().activeRun?.runId, 'run-next')
  assert.deepEqual(coordinator.getState().items, [])
  assert.deepEqual(subscriptions, ['run-next'])
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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
  const coordinator = coordinatorFixture({
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

test('only definite rejection replaces the request id and target on retry', async (context) => {
  for (const [name, error, uncertain] of [
    ['HTTP 500', { response: { status: 500 } }, true],
    ['HTTP 503', { response: { status: 503 } }, true],
    ['business 50000', { response: { status: 200, data: { code: 50000 } } }, true],
    ['business 40900', { response: { status: 200, data: { code: 40900 } } }, false],
    ['HTTP 409', { response: { status: 409 } }, false],
  ] as const) {
    await context.test(name, async (subtest) => {
      const bodies: unknown[] = []
      let requests = 0
      const coordinator = coordinatorFixture({
        createRequestId: () => `request-${++requests}`,
        enqueue: async (body) => {
          bodies.push(body)
          if (bodies.length === 1) throw error
          return queuedItem({ clientRequestId: body.clientRequestId })
        },
      })
      subtest.after(() => coordinator.dispose())
      coordinator.observeActiveRun({ runId: 'original', status: 'running' })
      await assert.rejects(coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'steer' }))
      coordinator.observeActiveRun({ runId: 'next', status: 'running' })
      await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'steer' })
      assert.deepEqual(bodies[1], {
        appId: 7,
        message: '修改标题',
        mode: 'steer',
        clientRequestId: uncertain ? 'request-1' : 'request-2',
        runId: uncertain ? 'original' : 'next',
      })
    })
  }
})

test('retrying an uncertain enqueue without an original target never adopts a later active run', async (context) => {
  const bodies: unknown[] = []
  const coordinator = coordinatorFixture({
    enqueue: async (body) => {
      bodies.push(body)
      if (bodies.length === 1) throw { response: { status: 500 } }
      return queuedItem()
    },
  })
  context.after(() => coordinator.dispose())
  await assert.rejects(coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'steer' }))
  coordinator.observeActiveRun({ runId: 'later-run', status: 'running' })
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'steer' })
  assert.deepEqual(bodies[1], bodies[0])
  assert.equal(Object.hasOwn(bodies[1] as object, 'runId'), false)
})

test('a normal run finishing between polls reconciles once without delaying the next subscription', async (context) => {
  const calls: string[] = []
  let reads = 0
  const item = queuedItem({ mode: 'normal' })
  const coordinator = coordinatorFixture({
    enqueue: async () => item,
    getQueue: async () => ({
      paused: false,
      items: ++reads === 1 ? [item] : [],
      activeRun: reads === 1 ? null : { runId: 'run-next', status: 'running' },
    }),
    findRunByRequest: async (appId, clientRequestId) => {
      calls.push(`find:${appId}:${clientRequestId}`)
      return { runId: 'run-missed', status: 'completed', errorSummary: null }
    },
    reconciled: (result) => calls.push(`history:${result.runId}:${result.status}`),
    subscribe: async (runId) => {
      calls.push(`subscribe:${runId}`)
      await new Promise<void>(() => undefined)
    },
  })
  context.after(() => coordinator.dispose())
  await coordinator.enqueue({ appId: 7, message: item.message, mode: 'normal' })
  assert.deepEqual(calls, [])
  await coordinator.refresh()
  await coordinator.refresh()
  assert.deepEqual(calls, [
    'subscribe:run-next',
    'find:7:request-1',
    'history:run-missed:completed',
  ])
})

test('a failed request lookup keeps polling after its normal queue item disappears', async (context) => {
  let lookups = 0
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const coordinator = coordinatorFixture({
    findRunByRequest: async () => {
      if (++lookups === 1) throw new Error('status temporarily unavailable')
      return { runId: 'run-fast', status: 'failed', errorSummary: 'build failed' }
    },
    reconciled: (result) => {
      assert.equal(result.status, 'failed')
      finish()
    },
    pollMs: 5,
  })
  context.after(() => coordinator.dispose())
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'normal' })
  await Promise.race([
    finished,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('terminal run was never reconciled')), 300)
      context.after(() => clearTimeout(timeout))
    }),
  ])
  assert.equal(lookups, 2)
})

test('queue items loaded from the server also recover runs missed between polls', async (context) => {
  let reads = 0
  const results: string[] = []
  const coordinator = coordinatorFixture({
    getQueue: async () => ({
      paused: false,
      items: ++reads === 1 ? [queuedItem({ mode: 'normal', status: 'claimed' })] : [],
      activeRun: null,
    }),
    findRunByRequest: async () => ({
      runId: 'run-loaded',
      status: 'cancelled',
      errorSummary: null,
    }),
    reconciled: (result) => results.push(result.runId),
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  await coordinator.refresh()
  assert.deepEqual(results, ['run-loaded'])
})

test('a request lookup that discovers a running run subscribes and later reconciles its terminal state', async (context) => {
  const calls: string[] = []
  const coordinator = coordinatorFixture({
    findRunByRequest: async () => {
      calls.push('find:request-1')
      return { runId: 'run-found', status: 'running', errorSummary: null }
    },
    subscribe: async (runId) => {
      calls.push(`subscribe:${runId}`)
      await new Promise<void>(() => undefined)
    },
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    reconciled: (result) => calls.push(`history:${result.runId}`),
  })
  context.after(() => coordinator.dispose())
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'normal' })
  assert.equal(coordinator.getState().activeRun?.runId, 'run-found')
  await coordinator.refresh()
  await coordinator.refresh()
  assert.equal(coordinator.getState().activeRun, null)
  assert.deepEqual(calls, ['find:request-1', 'subscribe:run-found', 'history:run-found'])
})

test('paused waiting normal messages do not trigger request lookups or repeated queue reads', async (context) => {
  let reads = 0
  const coordinator = coordinatorFixture({
    getQueue: async () => {
      reads += 1
      return { paused: true, items: [queuedItem({ mode: 'normal' })], activeRun: null }
    },
    findRunByRequest: async () => assert.fail('waiting items have no run to look up'),
    pollMs: 5,
  })
  context.after(() => coordinator.dispose())
  await coordinator.refresh()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(reads, 1)
})

test('a duplicate started enqueue follows its run even when queue reads fail', async (context) => {
  const calls: string[] = []
  const coordinator = coordinatorFixture({
    enqueue: async () => queuedItem({ mode: 'normal', status: 'started', runId: 'run-retry' }),
    getQueue: async () => {
      throw new Error('queue unavailable')
    },
    subscribe: async (runId) => {
      calls.push(`subscribe:${runId}`)
      throw new Error('SSE disconnected')
    },
    cancel: async (runId) => calls.push(`cancel:${runId}`),
  })
  context.after(() => coordinator.dispose())
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'normal' })
  assert.equal(coordinator.getState().activeRun?.runId, 'run-retry')
  assert.deepEqual(calls, ['subscribe:run-retry'])
  await coordinator.stop()
  assert.deepEqual(calls, ['subscribe:run-retry', 'cancel:run-retry'])
})

test('a stale GET cannot erase a duplicate started enqueue run', async (context) => {
  let resolveStale!: (state: MessageQueueState) => void
  const stale = new Promise<MessageQueueState>((resolve) => (resolveStale = resolve))
  let reads = 0
  const coordinator = coordinatorFixture({
    enqueue: async () => queuedItem({ mode: 'normal', status: 'started', runId: 'run-retry' }),
    getQueue: async () => {
      if (++reads === 1) return stale
      throw new Error('queue unavailable')
    },
  })
  context.after(() => coordinator.dispose())
  const refreshing = coordinator.refresh()
  await coordinator.enqueue({ appId: 7, message: '修改标题', mode: 'normal' })
  resolveStale({ paused: false, items: [], activeRun: null })
  await refreshing
  assert.equal(coordinator.getState().activeRun?.runId, 'run-retry')
})

const pageSource = readFileSync(
  new URL('../src/pages/app/AppChatPage.vue', import.meta.url),
  'utf8',
)
const pageDescriptor = parse(pageSource).descriptor

const pageAction = (name: string, bindings: Record<string, unknown>, property?: string) => {
  const script = ts.createSourceFile(
    'AppChatPage.ts',
    pageDescriptor.scriptSetup!.content,
    ts.ScriptTarget.Latest,
    true,
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(script) === name) {
      initializer = node.initializer
      if (property && initializer && ts.isCallExpression(initializer)) {
        const dependencies = initializer.arguments[0]
        assert.ok(dependencies && ts.isObjectLiteralExpression(dependencies))
        const entry = dependencies.properties.find(
          (entry) => entry.name?.getText(script) === property,
        )
        assert.ok(entry && ts.isPropertyAssignment(entry))
        initializer = entry.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(script)
  assert.ok(initializer, `missing page action ${name}`)
  const compiled = ts.transpileModule(`const action = ${initializer.getText(script)}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText
  return new Function(...Object.keys(bindings), `${compiled}; return action`)(
    ...Object.values(bindings),
  )
}

test('returned items expose independent delete and restore actions without overwriting drafts', async () => {
  const template = pageDescriptor.template!
  const start = template.content.indexOf('<div v-for="item in queueItems"')
  const end = template.content.indexOf('\n          </div>', start)
  assert.ok(start >= 0 && end > start)
  const compiled = compileTemplate({
    source: template.content.slice(start, end),
    filename: 'AppChatPage.vue',
    id: 'queue-actions',
  })
  assert.deepEqual(compiled.errors, [])
  const render = new Function(
    'Vue',
    compiled.code
      .replace(
        /import \{([^}]+)\} from "vue"/,
        (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue`,
      )
      .replace('export function render', 'return function render'),
  )({ ...Vue, resolveComponent: (name: string) => name })
  const item = queuedItem({ status: 'returned' })
  const inputMessage = { value: '未发送的新草稿' }
  const localReturnedRestores = { value: [item] }
  const queueActionBusy = { value: false }
  const removed: string[] = []
  const removeQueueItem = pageAction('removeQueueItem', {
    queueActionBusy,
    localReturnedRestores,
    queueState: { value: { items: [item] } },
    queuedChatCoordinator: { remove: async (id: string) => removed.push(id) },
    message: { error: () => assert.fail('removal should succeed') },
  })
  const restoreQueueItem = pageAction('restoreQueueItem', {
    inputMessage,
    returnedItemDraft,
    hasDraftContent: { value: true },
    message: { info: () => undefined },
  })
  const tree = render(
    {
      queueItems: [item],
      queueItemLabel,
      hasDraftContent: true,
      queueActionBusy: false,
      removeQueueItem,
      restoreQueueItem,
    },
    [],
  )
  const nodes: Vue.VNode[] = []
  const collect = (node: Vue.VNode) => {
    nodes.push(node)
    if (Array.isArray(node.children))
      node.children.forEach((child) => {
        if (typeof child === 'object' && child) collect(child as Vue.VNode)
      })
  }
  collect(tree)
  const restore = nodes.find((node) => node.props?.['aria-label'] === '恢复为草稿')
  const remove = nodes.find((node) => node.props?.['aria-label'] === '移出队列')
  assert.ok(restore)
  assert.ok(remove, 'returned item must have a direct delete button')
  assert.equal(restore.props!.disabled, true)
  assert.equal(remove.props!.disabled, false)
  assert.equal(await restoreQueueItem(item), false)
  await remove.props!.onClick()
  assert.deepEqual(removed, [item.id])
  assert.deepEqual(localReturnedRestores.value, [])
  assert.equal(inputMessage.value, '未发送的新草稿')
})

test('recovering an older terminal run cannot change the active run indicator', () => {
  const runStatus = { value: 'running' }
  const terminalRunStatuses = new Map<string, string>()
  const item = { status: 'streaming', modelProgress: '处理中', errorSummary: null }
  let historyLoads = 0
  const handleEvent = pageAction('handleEvent', {
    runStatus,
    runId: { value: 'run-current' },
    terminalRunStatuses,
    queueState: { value: { activeRun: { runId: 'run-current', status: 'running' } } },
    ensureAssistantItem: () => item,
    loadDetails: () => undefined,
    loadHistory: () => {
      historyLoads += 1
    },
    syncPreview: () => undefined,
  })
  handleEvent({
    runId: 'run-old',
    type: 'run-finished',
    payload: { status: 'failed', errorSummary: '旧轮次失败' },
  })
  assert.equal(runStatus.value, 'running')
  assert.equal(item.status, 'failed')
  assert.equal(terminalRunStatuses.get('run-old'), 'failed')
  assert.equal(historyLoads, 1)
})

test('an older terminal result cannot replace a newer failed result after the queue becomes idle', () => {
  const runStatus = { value: 'failed' }
  const runId = { value: 'run-newer' }
  const item = { status: 'streaming', modelProgress: '', errorSummary: null }
  const terminalRunStatuses = new Map([['run-newer', 'failed']])
  const handleEvent = pageAction('handleEvent', {
    runStatus,
    runId,
    terminalRunStatuses,
    queueState: { value: { activeRun: null } },
    ensureAssistantItem: () => item,
    loadDetails: () => undefined,
    loadHistory: () => undefined,
    syncPreview: () => undefined,
  })
  handleEvent({ runId: 'run-old', type: 'run-finished', payload: { status: 'completed' } })
  assert.equal(runStatus.value, 'failed')
  assert.equal(runId.value, 'run-newer')
  assert.equal(item.status, 'completed')
})

test('fresh idle history owns the latest run but a response requested before a new run cannot replace it', async () => {
  const runId = { value: 'run-old' }
  const runStatus = { value: 'completed' }
  let resolveHistory!: (result: unknown) => void
  const pending = new Promise((resolve) => {
    resolveHistory = resolve
  })
  const record = { role: 'assistant', runId: 'run-missed', status: 'failed', id: 12 }
  let response: Promise<unknown> = Promise.resolve({
    data: { code: 0, data: { records: [record], hasMore: false } },
  })
  const loadHistory = pageAction('loadHistory', {
    runId,
    runStatus,
    disposed: false,
    appId: 7,
    historyLoading: { value: false },
    historyQueue: { run: (work: () => unknown) => work() },
    listAppChatHistory: () => response,
    toChatItem: (item: unknown) => item,
    messages: { value: [] },
    nextCursor: { value: null },
    hasMore: { value: false },
    scrollPinned: { value: false },
    scrollToBottom: () => undefined,
    queueState: { value: { activeRun: null } },
    terminalRunStatuses: new Map<string, string>(),
    loadDetails: () => undefined,
    message: { error: () => assert.fail('history must load successfully') },
  })
  await loadHistory(true)
  assert.equal(runId.value, 'run-missed')
  assert.equal(runStatus.value, 'failed')
  response = pending
  const loading = loadHistory(true)
  runId.value = 'run-latest'
  runStatus.value = 'completed'
  resolveHistory({ data: { code: 0, data: { records: [record], hasMore: false } } })
  await loading
  assert.equal(runId.value, 'run-latest')
  assert.equal(runStatus.value, 'completed')
})

test('enqueue business errors keep their envelope and run lookup passes both request selectors', async () => {
  const response = { status: 200, data: { code: 50000, message: '依赖异常', data: null } }
  const enqueue = pageAction(
    'queuedChatCoordinator',
    { enqueueMessage: async () => response },
    'enqueue',
  )
  await assert.rejects(enqueue({}), (error) => {
    assert.equal((error as { response: unknown }).response, response)
    return isUnknownEnqueueOutcome(error)
  })
  const selectors: unknown[] = []
  const findRun = pageAction(
    'queuedChatCoordinator',
    {
      getRunStatus: async (params: unknown) => {
        selectors.push(params)
        return {
          data: { code: 0, data: { runId: 'actual-run', status: 'completed', errorSummary: null } },
        }
      },
    },
    'findRunByRequest',
  )
  assert.deepEqual(await findRun(7, 'request-1'), {
    runId: 'actual-run',
    status: 'completed',
    errorSummary: null,
  })
  assert.deepEqual(selectors, [{ appId: 7, clientRequestId: 'request-1' }])
})

test('editing during restoration retains the returned message and local deletion leaves the new draft intact', async () => {
  const item = queuedItem({ status: 'returned' })
  const inputMessage = { value: '' }
  const queueState = { value: { items: [item] } }
  const localReturnedRestores = { value: [] as QueueItem[] }
  const queueActionBusy = { value: false }
  let removals = 0
  const removeQueueItem = pageAction('removeQueueItem', {
    queueActionBusy,
    queueState,
    localReturnedRestores,
    queuedChatCoordinator: {
      remove: async () => {
        removals += 1
        queueState.value.items = []
        inputMessage.value = '恢复期间输入的新草稿'
      },
    },
  })
  const restoreQueueItem = pageAction('restoreQueueItem', {
    inputMessage,
    localReturnedRestores,
    returnedItemDraft,
    draftAfterReturnedRemoval,
    draftRevision: 0,
    removeQueueItem,
    message: { info: () => undefined },
  })
  assert.equal(await restoreQueueItem(item), true)
  assert.equal(inputMessage.value, '恢复期间输入的新草稿')
  assert.deepEqual(localReturnedRestores.value, [item])
  assert.equal(await removeQueueItem(item), true)
  assert.equal(removals, 1, 'local restore must not require a second server removal')
  assert.deepEqual(localReturnedRestores.value, [])
  assert.equal(inputMessage.value, '恢复期间输入的新草稿')
})
