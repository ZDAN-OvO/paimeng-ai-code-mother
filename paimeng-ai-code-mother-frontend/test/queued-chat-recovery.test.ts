import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorFixture, queuedItem } from './support/queue.ts'
import type { QueueItem } from '../src/api/chatTypes.ts'

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
