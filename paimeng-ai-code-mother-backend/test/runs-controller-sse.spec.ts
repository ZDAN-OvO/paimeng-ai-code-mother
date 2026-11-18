import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { RunsController } from '../src/runs/runs.controller'
import { RunStream } from '../src/runs/run-stream'

class FakeResponse extends EventEmitter {
  writableEnded = false
  status() {
    return this
  }
  setHeader() {
    return this
  }
  flushHeaders() {
    return undefined
  }
  write() {
    return true
  }
  end() {
    this.writableEnded = true
  }
}

describe('SSE disconnect handling', () => {
  it('only unsubscribes when the stream disconnects before the final event', async () => {
    const stream = new RunStream('run-disconnect')
    const subscribe = stream.subscribe.bind(stream)
    const unsubscribe = vi.fn()
    vi.spyOn(stream, 'subscribe').mockImplementation((listener) => {
      const remove = subscribe(listener)
      return () => {
        unsubscribe()
        return remove() === true
      }
    })
    let cancelled = 0
    const runs = {
      startRun: async () => ({ runId: stream.runId, reused: false }),
      getStream: () => stream,
      latestFinishedEvent: async () => null,
      cancelRun: async () => {
        cancelled += 1
        return { runId: stream.runId, status: 'cancelling' }
      },
    }
    const controller = new RunsController(runs as never, {} as never)
    const response = new FakeResponse()
    await controller.chat(
      { appId: 1, message: '生成页面', clientRequestId: 'request-0001' } as never,
      1,
      {} as never,
      response as never,
    )

    response.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(0)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not cancel after a normal run-finished close', async () => {
    const stream = new RunStream('run-finished')
    let cancelled = 0
    const runs = {
      startRun: async () => ({ runId: stream.runId, reused: false }),
      getStream: () => stream,
      latestFinishedEvent: async () => null,
      cancelRun: async () => {
        cancelled += 1
        return { runId: stream.runId, status: 'cancelling' }
      },
    }
    const controller = new RunsController(runs as never, {} as never)
    const response = new FakeResponse()
    await controller.chat(
      { appId: 1, message: '生成页面', clientRequestId: 'request-0002' } as never,
      1,
      {} as never,
      response as never,
    )

    stream.emit({
      type: 'data-run',
      id: `run:${stream.runId}`,
      transient: true,
      data: { runId: stream.runId, status: 'completed' },
    })
    stream.finish()
    response.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(0)
    expect(response.writableEnded).toBe(true)
  })
})
