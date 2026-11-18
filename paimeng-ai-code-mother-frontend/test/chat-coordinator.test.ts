import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskQueue } from '../src/utils/chatCoordinator.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

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
