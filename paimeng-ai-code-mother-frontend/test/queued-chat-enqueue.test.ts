import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatorFixture, queuedItem } from './support/queue.ts'
import type { MessageQueueState } from '../src/api/chatTypes.ts'

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
