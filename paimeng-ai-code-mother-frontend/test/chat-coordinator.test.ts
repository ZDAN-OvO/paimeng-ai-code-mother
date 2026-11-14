import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createChatCoordinator,
  createTaskQueue,
  ChatSubmissionRejected,
  type ChatRequest,
  type ChatState,
  type RunSnapshot,
} from '../src/utils/chatCoordinator.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Event = { type: string; runId: string; payload: Record<string, unknown> }
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function harness(pollAttempts = 1) {
  const streams: {
    request: ChatRequest
    emit: (event: Event) => void
    signal: AbortSignal
    done: ReturnType<typeof deferred>
  }[] = []
  const calls: string[] = []
  let snapshot: RunSnapshot | null = { runId: 'old', status: 'running' }
  let state!: ChatState
  let id = 0
  let draft = ''
  const refresh = deferred()
  let holdRefresh = false
  const sleep = deferred()
  const cancelGate = deferred()
  const lookupGate = deferred()
  let holdCancel = false
  let holdLookup = false
  let failCancel = false
  const coordinator = createChatCoordinator<Event>({
    createRequestId: () => `request-${++id}`,
    beforeStart: async () => undefined,
    start: (request) => calls.push(`start:${request.text}`),
    accepted: (request) => {
      if (draft === request.draft) draft = ''
    },
    stream: (request, emit, signal) => {
      const done = deferred()
      streams.push({ request, emit, signal, done })
      return done.promise
    },
    lookup: async (query) => {
      calls.push(`lookup:${query.runId ?? query.clientRequestId}`)
      const result = snapshot
      if (holdLookup) await lookupGate.promise
      return result
    },
    cancel: async (runId) => {
      calls.push(`cancel:${runId}`)
      if (failCancel) throw new Error('停止失败')
      if (holdCancel) await cancelGate.promise
    },
    refresh: async () => {
      calls.push('refresh')
      if (holdRefresh) await refresh.promise
    },
    event: (event) => calls.push(`event:${event.runId}:${event.type}`),
    changed: (next) => (state = next),
    error: (error) => calls.push(`error:${error.message}`),
    sleep: () => sleep.promise,
    pollAttempts,
  })
  const started = (index = 0, runId = 'old') =>
    streams[index]!.emit({ type: 'run-started', runId, payload: {} })
  const finished = (index = 0, runId = 'old') =>
    streams[index]!.emit({ type: 'run-finished', runId, payload: { status: 'cancelled' } })
  return {
    coordinator,
    streams,
    calls,
    started,
    finished,
    refresh,
    sleep,
    cancelGate,
    lookupGate,
    state: () => state,
    setSnapshot: (next: RunSnapshot | null) => (snapshot = next),
    holdRefresh: () => (holdRefresh = true),
    holdCancel: () => (holdCancel = true),
    holdLookup: () => (holdLookup = true),
    failCancel: (fail: boolean) => (failCancel = fail),
    setDraft: (text: string) => (draft = text),
    draft: () => draft,
  }
}

test('interrupt waits for terminal, old stream finally and history before a fresh request', async () => {
  const h = harness(2)
  h.setDraft('第一轮')
  await h.coordinator.submit('第一轮')
  h.started()
  h.holdRefresh()
  h.setDraft('修改标题')
  const replacement = h.coordinator.submit('修改标题')
  await tick()
  assert.deepEqual(
    h.calls.filter((call) => call.startsWith('cancel:')),
    ['cancel:old'],
  )
  assert.equal(h.streams.length, 1)
  assert.equal(h.draft(), '修改标题')
  h.finished()
  h.sleep.resolve()
  await tick()
  assert.equal(h.streams[0]!.signal.aborted, true)
  assert.equal(h.streams.length, 1, 'terminal alone must not release the old stream')
  h.streams[0]!.done.resolve()
  await tick()
  assert.equal(
    h.streams.length,
    1,
    'old history refresh must finish before new optimistic messages',
  )
  h.refresh.resolve()
  await replacement
  await tick()
  assert.equal(h.streams.length, 2)
  assert.notEqual(h.streams[0]!.request.clientRequestId, h.streams[1]!.request.clientRequestId)
  assert.ok(h.calls.indexOf('refresh') < h.calls.indexOf('start:修改标题'))
  h.started(1, 'new')
  assert.equal(h.state().phase, 'running')
  assert.equal(h.draft(), '')
  const count = h.calls.length
  h.finished(0)
  assert.equal(h.calls.length, count, 'late old events must not mutate the new turn')
  assert.equal(h.state().run?.runId, 'new')
  h.coordinator.dispose()
})

test('double send and stop share one transition; editing during stop does not lose the new draft', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  h.setDraft('已提交修改')
  const replacement = h.coordinator.submit('已提交修改')
  assert.equal(await h.coordinator.submit('重复点击'), false)
  const stop = h.coordinator.stop()
  h.setDraft('继续输入下一条')
  h.finished()
  h.setSnapshot({ runId: 'old', status: 'cancelled' })
  h.sleep.resolve()
  h.streams[0]!.done.resolve()
  await Promise.all([replacement, stop])
  await tick()
  assert.equal(h.streams.length, 2)
  assert.equal(h.streams[1]!.request.text, '已提交修改')
  h.started(1, 'new')
  assert.equal(h.draft(), '继续输入下一条')
  assert.equal(h.calls.filter((call) => call === 'cancel:old').length, 1)
  h.coordinator.dispose()
})

test('failed cancel keeps pending text, leaves the old stream intact and permits stop retry', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  h.setDraft('待发修改')
  h.failCancel(true)
  assert.equal(await h.coordinator.submit('待发修改'), false)
  assert.equal(h.state().pending, '待发修改')
  assert.equal(h.draft(), '待发修改')
  assert.equal(h.streams[0]!.signal.aborted, false)
  assert.equal(h.state().canStop, true)
  assert.equal(h.state().canSubmit, true)
  h.failCancel(false)
  h.setSnapshot({ runId: 'old', status: 'cancelled' })
  const retry = h.coordinator.stop()
  await tick()
  h.streams[0]!.done.resolve()
  await retry
  await tick()
  assert.equal(h.streams.length, 2)
  assert.equal(h.streams[1]!.request.text, '待发修改')
  h.coordinator.dispose()
})

test('unconfirmed terminal never starts replacement even after the stream closes', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  h.streams[0]!.done.resolve()
  await tick()
  assert.equal(h.state().phase, 'blocked')
  h.setDraft('待发')
  assert.equal(await h.coordinator.submit('待发'), false)
  assert.equal(h.streams.length, 1)
  assert.equal(h.state().pending, '待发')
  assert.equal(h.state().canStop, true)
  h.coordinator.dispose()
})

test('first SSE missing is reconciled by request id, not treated as idle or resent', async () => {
  const h = harness(2)
  await h.coordinator.submit('第一轮')
  assert.equal(h.state().canSubmit, false)
  const stop = h.coordinator.stop()
  await tick()
  assert.ok(h.calls.includes('cancel:old'))
  assert.ok(h.calls.includes('lookup:request-1'))
  h.setSnapshot({ runId: 'old', status: 'cancelled' })
  h.finished()
  h.sleep.resolve()
  h.streams[0]!.done.resolve()
  await stop
  assert.equal(h.state().phase, 'idle')
  h.coordinator.dispose()
})

test('restored active run can be interrupted without an attached SSE stream', async () => {
  const h = harness()
  h.coordinator.restore({ runId: 'old', status: 'running' })
  h.setSnapshot({ runId: 'old', status: 'completed' })
  await h.coordinator.submit('新内容')
  await tick()
  assert.equal(h.streams.length, 1)
  assert.equal(h.streams[0]!.request.text, '新内容')
  assert.ok(h.calls.indexOf('refresh') < h.calls.indexOf('start:新内容'))
  h.coordinator.dispose()
})

test('dispose during cancellation aborts only the owned stream and never starts pending work', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  const replacement = h.coordinator.submit('新内容')
  await tick()
  h.coordinator.dispose()
  h.sleep.resolve()
  h.streams[0]!.done.resolve()
  await replacement
  assert.equal(h.streams.length, 1)
  assert.equal(h.calls.includes('start:新内容'), false)
})

test('history queue waits for an already loading page and a fresh reset before starting', async () => {
  const queue = createTaskQueue()
  const old = deferred()
  const order: string[] = []
  const page = queue.run(async () => {
    await old.promise
    order.push('old-page')
  })
  const reset = queue.run(async () => {
    order.push('reset')
  })
  const start = queue.idle().then(() => order.push('new-run'))
  await tick()
  assert.deepEqual(order, [])
  old.resolve()
  await Promise.all([page, reset, start])
  assert.deepEqual(order, ['old-page', 'reset', 'new-run'])
})

test('natural completion while cancellation response is pending still sends the queued message', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  h.holdCancel()
  const replacement = h.coordinator.submit('下一轮')
  await tick()
  h.finished()
  h.streams[0]!.done.resolve()
  await tick()
  assert.ok(h.calls.includes('refresh'))
  h.cancelGate.resolve()
  assert.equal(await replacement, true)
  await tick()
  assert.equal(h.streams.length, 2)
  h.coordinator.dispose()
})

test('missing run after a network error stays blocked; an explicit HTTP rejection permits retry', async () => {
  for (const error of [new Error('offline'), new ChatSubmissionRejected('限流')]) {
    const h = harness()
    h.setSnapshot(null)
    h.setDraft('保留输入')
    await h.coordinator.submit('保留输入')
    h.streams[0]!.done.reject(error)
    await tick()
    assert.equal(h.draft(), '保留输入')
    assert.equal(h.state().phase, error instanceof ChatSubmissionRejected ? 'idle' : 'blocked')
    assert.equal(h.streams.length, 1)
    h.coordinator.dispose()
  }
})

test('status confirmation also acknowledges the original input when the first SSE was lost', async () => {
  const h = harness()
  h.setDraft('已接收的请求')
  await h.coordinator.submit('已接收的请求')
  h.setSnapshot({ runId: 'old', status: 'completed' })
  h.streams[0]!.done.resolve()
  await tick()
  assert.ok(h.calls.includes('lookup:request-1'))
  assert.equal(h.draft(), '')
  assert.equal(h.state().phase, 'idle')
  h.coordinator.dispose()
})

test('late running status cannot regress the terminal SSE or release a replacement early', async () => {
  const h = harness()
  await h.coordinator.submit('第一轮')
  h.started()
  h.holdLookup()
  const replacement = h.coordinator.submit('下一轮')
  await tick()
  h.finished()
  h.lookupGate.resolve()
  await tick()
  assert.equal(h.state().run?.status, 'cancelled')
  assert.equal(h.streams.length, 1)
  h.streams[0]!.done.resolve()
  await replacement
  await tick()
  assert.equal(h.streams.length, 2)
  h.coordinator.dispose()
})
