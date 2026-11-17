import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { TEST_TIMEOUT, deferred, withHarness } from './support.mjs'

const options = { timeout: TEST_TIMEOUT }

test('real Lua CAS retries concurrent duplicate enqueues and persists one item', options, async () => {
  await withHarness(async ({ fixture, queue, redis }) => {
    const app = await fixture()
    const client = redis.client
    const key = `chat:queue:app:${app.appId}`
    const request = { message: 'same content', clientRequestId: randomUUID(), mode: 'normal' }
    const contenders = 12
    const barrier = deferred()
    const originalGet = client.get
    const originalEval = client.eval
    let reads = 0
    let retries = 0
    // Scheduling instrumentation only: every GET/EVAL still reaches real Redis.
    // Hold the initial GET responses until all contenders observed the empty key,
    // guaranteeing a CAS conflict rather than relying on scheduler timing.
    client.get = async function (...args) {
      const value = await originalGet.apply(this, args)
      if (args[0] === key && reads < contenders) {
        reads += 1
        if (reads === contenders) barrier.resolve()
        await barrier.promise
      }
      return value
    }
    client.eval = async function (...args) {
      const value = await originalEval.apply(this, args)
      if (args[1]?.keys?.[0] === key && Number(value) === 0) retries += 1
      return value
    }
    let pending = []
    try {
      pending = Array.from({ length: contenders }, () => queue.enqueue(app.appId, request))
      const results = await Promise.all(pending)
      assert.equal(new Set(results.map((item) => item.id)).size, 1)
      // 只要求「发生过重试」：重试次数绑定了单次 CAS 的实现方式，换 WATCH/MULTI 后行为正确也会失败。
      assert.ok(retries >= 1, 'A losing CAS must retry against the stored state')
      assert.equal((await queue.allItems(app.appId)).length, 1)
      const raw = JSON.parse(await originalGet.call(client, key))
      assert.equal(raw.nextSeq, 1)
      assert.equal(raw.items.length, 1)
      assert.equal(raw.items[0].clientRequestId, request.clientRequestId)
      assert.equal(Number(await client.sIsMember('chat:queue:apps', String(app.appId))), 1)
    } finally {
      barrier.resolve()
      await Promise.allSettled(pending)
      client.get = originalGet
      client.eval = originalEval
    }
  })
})

test(
  'real CAS preserves all distinct enqueues and returns 409 for conflicting request payloads',
  options,
  async () => {
    await withHarness(async ({ fixture, queue }) => {
      const app = await fixture()
      const requests = Array.from({ length: 12 }, (_, index) => ({
        message: `message ${index}`,
        clientRequestId: randomUUID(),
        mode: 'normal',
      }))
      const items = await Promise.all(requests.map((request) => queue.enqueue(app.appId, request)))
      assert.equal(new Set(items.map((item) => item.id)).size, 12)
      assert.deepEqual(
        new Set((await queue.allItems(app.appId)).map((item) => item.clientRequestId)),
        new Set(requests.map((request) => request.clientRequestId)),
      )

      const requestId = randomUUID()
      const competing = await Promise.allSettled(
        ['first', 'second'].map((message) =>
          queue.enqueue(app.appId, { clientRequestId: requestId, message, mode: 'normal' }),
        ),
      )
      assert.equal(competing.filter((entry) => entry.status === 'fulfilled').length, 1)
      const failed = competing.filter((entry) => entry.status === 'rejected')
      assert.equal(failed.length, 1)
      assert.equal(failed[0].reason.status, 409)
      const winner = competing.find((entry) => entry.status === 'fulfilled').value
      assert.equal((await queue.snapshot(app.appId, requestId)).requestedItem.message, winner.message)
      await assert.rejects(
        queue.enqueue(app.appId, {
          clientRequestId: requestId,
          message: winner.message,
          mode: 'steer',
        }),
        { status: 409 },
      )
    })
  },
)

test(
  'cancel pauses dispatch, closes steer intake, returns pending steers and permits explicit resume',
  options,
  async () => {
    await withHarness(async ({ fixture, queue }) => {
      const { appId } = await fixture()
      const normal = await queue.enqueue(appId, {
        message: 'first',
        clientRequestId: randomUUID(),
        mode: 'normal',
      })
      const next = await queue.enqueue(appId, {
        message: 'next',
        clientRequestId: randomUUID(),
        mode: 'normal',
      })
      await queue.pause(appId)
      assert.equal(await queue.claimNormal(appId), null)
      assert.equal((await queue.resume(appId)).paused, false)
      assert.equal((await queue.claimNormal(appId)).id, normal.id)
      const runId = randomUUID()
      await queue.ackNormal(appId, normal.id, runId)
      await queue.openRun(appId, runId)
      const consumed = await queue.enqueue(appId, {
        message: 'applied',
        clientRequestId: randomUUID(),
        mode: 'steer',
        runId,
      })
      await queue.claimSteers(appId, runId)
      await queue.ackSteers(appId, runId, [consumed.id])
      const claimed = await queue.enqueue(appId, {
        message: 'claimed',
        clientRequestId: randomUUID(),
        mode: 'steer',
        runId,
      })
      await queue.claimSteers(appId, runId)
      const queued = await queue.enqueue(appId, {
        message: 'queued',
        clientRequestId: randomUUID(),
        mode: 'steer',
        runId,
      })
      await queue.markCancelling(appId, runId)
      const cancelling = await queue.snapshot(appId)
      assert.equal(cancelling.paused, true)
      assert.deepEqual(cancelling.activeRun, { runId, status: 'cancelling' })
      await assert.rejects(
        queue.enqueue(appId, { message: 'late', clientRequestId: randomUUID(), mode: 'steer', runId }),
        { status: 409 },
      )
      assert.equal(await queue.claimNormal(appId), null)
      await queue.finishRun(appId, runId, 'cancelled')
      const allItems = await queue.allItems(appId)
      assert.equal(allItems.find((item) => item.id === consumed.id).status, 'applied')
      assert.equal(allItems.find((item) => item.id === claimed.id).status, 'returned')
      assert.equal(allItems.find((item) => item.id === queued.id).status, 'returned')
      assert.equal((await queue.snapshot(appId)).activeRun, null)
      assert.equal(await queue.claimNormal(appId), null)
      assert.equal((await queue.resume(appId)).paused, false)
      assert.equal((await queue.claimNormal(appId)).id, next.id)
      await queue.releaseNormal(appId, next.id)
      const nextRun = randomUUID()
      await queue.openRun(appId, nextRun)
      // Late duplicate signals from the old run cannot pause or replace the new run.
      await queue.finishRun(appId, runId, 'cancelled')
      await queue.markCancelling(appId, runId)
      await queue.openRun(appId, runId)
      const snapshot = await queue.snapshot(appId)
      assert.equal(snapshot.paused, false)
      assert.deepEqual(snapshot.activeRun, { runId: nextRun, status: 'running' })
      await assert.rejects(
        queue.enqueue(appId, {
          message: 'closed target',
          clientRequestId: randomUUID(),
          mode: 'steer',
          runId,
        }),
        { status: 409 },
      )
    })
  },
)

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`terminal ${status} clears active run and preserves its pause policy`, options, async () => {
    await withHarness(async ({ fixture, queue }) => {
      const { appId } = await fixture()
      const runId = randomUUID()
      await queue.openRun(appId, runId)
      const steer = await queue.enqueue(appId, {
        message: 'unconsumed',
        clientRequestId: randomUUID(),
        mode: 'steer',
        runId,
      })
      await queue.finishRun(appId, runId, status)
      const snapshot = await queue.snapshot(appId)
      assert.equal(snapshot.activeRun, null)
      assert.equal(snapshot.paused, status !== 'completed')
      assert.deepEqual(snapshot.items, [{ ...steer, status: 'returned' }])
      await queue.resume(appId)
      await queue.finishRun(appId, runId, status)
      assert.equal((await queue.snapshot(appId)).paused, false)
      await queue.remove(appId, steer.id)
      assert.deepEqual((await queue.snapshot(appId, steer.clientRequestId)).requestedItem, {
        ...steer,
        status: 'removed',
      })
    })
  })
}

test('real CAS serializes steer intake closure against a concurrent enqueue', options, async () => {
  await withHarness(async ({ fixture, queue }) => {
    const { appId } = await fixture()
    const runId = randomUUID()
    await queue.openRun(appId, runId)
    const [closed, enqueued] = await Promise.allSettled([
      queue.closeSteerIntake(appId, runId),
      queue.enqueue(appId, { message: 'at boundary', clientRequestId: randomUUID(), mode: 'steer', runId }),
    ])
    assert.equal(closed.status, 'fulfilled')
    if (closed.value) {
      assert.equal(enqueued.status, 'rejected')
      assert.equal(enqueued.reason.status, 409)
      assert.deepEqual((await queue.snapshot(appId)).items, [])
    } else {
      assert.equal(enqueued.status, 'fulfilled')
      assert.equal((await queue.snapshot(appId)).items.length, 1)
      const batch = await queue.claimSteers(appId, runId)
      await queue.ackSteers(
        appId,
        runId,
        batch.map((item) => item.id),
      )
      assert.equal(await queue.closeSteerIntake(appId, runId), true)
    }
    await assert.rejects(
      queue.enqueue(appId, { message: 'after closure', clientRequestId: randomUUID(), mode: 'steer', runId }),
      { status: 409 },
    )
  })
})
