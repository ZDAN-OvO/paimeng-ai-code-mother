import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorFixture, queuedItem } from './support/queue.ts'
import type { MessageQueueState } from '../src/api/chatTypes.ts'

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
