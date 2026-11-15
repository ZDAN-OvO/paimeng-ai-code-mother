import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { DbService } from '../src/db/db.module'
import { MessageQueueStore } from '../src/runs/message-queue.store'
import { RunsService } from '../src/runs/runs.service'
import { AppMutexService } from '../src/runtime/app-mutex.service'
import { ApiException } from '../src/common/api'

async function setup(
  status: string,
  updated: unknown[] = [],
  currentRun = { id: 'old-run', status: 'completed' },
) {
  let storedStatus = status
  const select = () => {
    let joined = false
    const query = {
      from: () => query,
      innerJoin: () => {
        joined = true
        return query
      },
      where: () => query,
      limit: async () =>
        joined ? [{ run: { id: 'old-run', appId: 1, status: storedStatus }, ownerId: 9 }] : [currentRun],
    }
    return query
  }
  const update = vi.fn(() => ({
    set: () => ({
      where: () => ({
        returning: async () => {
          if (storedStatus !== 'running') return []
          if (updated.length) storedStatus = 'cancelling'
          return updated
        },
      }),
    }),
  }))
  const queue = {
    pause: vi.fn(),
    markCancelling: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({ paused: false, activeRun: null, items: [], requestedItem: null }),
  }
  const appsService = {
    getAppVO: vi.fn(async (_appId: number, userId: number) => {
      if (userId !== 9) throw ApiException.forbidden('无权访问此应用')
    }),
  }
  const runtime = { stopTask: vi.fn(), isTaskRunning: vi.fn().mockResolvedValue(false) }
  const module = await Test.createTestingModule({
    providers: [
      { provide: DbService, useValue: { db: { select, update } } },
      { provide: MessageQueueStore, useValue: queue },
      AppMutexService,
      {
        provide: RunsService,
        inject: [DbService, MessageQueueStore, AppMutexService],
        useFactory: (db: DbService, store: MessageQueueStore, mutex: AppMutexService) =>
          new RunsService(
            {} as never,
            db,
            {} as never,
            appsService as never,
            {} as never,
            {} as never,
            runtime as never,
            {} as never,
            mutex,
            store,
          ),
      },
    ],
  }).compile()
  return { module, service: module.get(RunsService), queue, runtime, update }
}

describe('queue cancellation identity', () => {
  it('checks the owner before querying a queue item by request ID', async () => {
    const { module, service, queue } = await setup('completed')
    await expect(service.getMessageQueue(8, 1, 'removed-request')).rejects.toMatchObject({ status: 403 })
    expect(queue.snapshot).not.toHaveBeenCalled()
    await service.getMessageQueue(9, 1, 'removed-request')
    expect(queue.snapshot).toHaveBeenCalledWith(1, 'removed-request')
    await module.close()
  })

  it.each(['completed', 'failed', 'cancelled'])('leaves the queue untouched for a %s run', async (status) => {
    const { module, service, queue, runtime, update } = await setup(status)
    expect(await service.cancelRun(9, 'old-run')).toEqual({ runId: 'old-run', status })
    expect(queue.pause).not.toHaveBeenCalled()
    expect(queue.markCancelling).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(runtime.stopTask).not.toHaveBeenCalled()
    await module.close()
  })

  it('does not mutate queue state when completion wins the cancellation update', async () => {
    const { module, service, queue, runtime } = await setup('running')
    expect(await service.cancelRun(9, 'old-run')).toEqual({ runId: 'old-run', status: 'completed' })
    expect(queue.pause).not.toHaveBeenCalled()
    expect(queue.markCancelling).not.toHaveBeenCalled()
    expect(runtime.stopTask).not.toHaveBeenCalled()
    await module.close()
  })

  it('does not stop a successor task when the cancelled run finishes during queue mutation', async () => {
    const { module, service, runtime } = await setup('running', [{ id: 'old-run' }], {
      id: 'new-run',
      status: 'running',
    })
    vi.spyOn(service, 'finalize').mockResolvedValue(undefined)
    await service.cancelRun(9, 'old-run')
    expect(runtime.stopTask).not.toHaveBeenCalled()
    expect(runtime.isTaskRunning).not.toHaveBeenCalled()
    await module.close()
  })

  it('stops the task and pauses the queue for the current cancelling run', async () => {
    const { module, service, queue, runtime } = await setup('running', [{ id: 'old-run' }], {
      id: 'old-run',
      status: 'cancelling',
    })
    vi.spyOn(service, 'finalize').mockResolvedValue(undefined)
    expect(await service.cancelRun(9, 'old-run')).toEqual({ runId: 'old-run', status: 'cancelling' })
    expect(queue.markCancelling).toHaveBeenCalledWith(1, 'old-run')
    expect(runtime.stopTask).toHaveBeenCalledWith(1)
    await module.close()
  })

  it('retries cancellation steps when Redis fails after the database update', async () => {
    const { module, service, queue, runtime } = await setup('running', [{ id: 'old-run' }], {
      id: 'old-run',
      status: 'cancelling',
    })
    const finalize = vi.spyOn(service, 'finalize').mockResolvedValue(undefined)
    queue.markCancelling.mockRejectedValueOnce(new Error('Redis unavailable'))
    await expect(service.cancelRun(9, 'old-run')).rejects.toThrow('Redis unavailable')
    expect(runtime.stopTask).not.toHaveBeenCalled()
    expect(await service.cancelRun(9, 'old-run')).toEqual({ runId: 'old-run', status: 'cancelling' })
    expect(queue.markCancelling).toHaveBeenCalledTimes(2)
    expect(runtime.stopTask).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledOnce()
    await module.close()
  })
})
