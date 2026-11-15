import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { DbService } from '../src/db/db.module'
import { apps, agentRuns } from '../src/db/schema'
import { assistantMessage } from '../src/conversations/ui-message'
import { MessageQueueStore } from '../src/runs/message-queue.store'
import { RunsService } from '../src/runs/runs.service'

describe('queue shutdown boundary', () => {
  it('retries finalization after Redis recovers and never commits a terminal run before intake is sealed', async () => {
    const order: string[] = []
    let status = 'running'
    const database = {
      db: {
        transaction: async (work: (tx: unknown) => Promise<void>) => {
          let nextStatus = status
          const query = {
            from: () => query,
            where: () => query,
            for: () => query,
            limit: async () => [{ id: 'run-1', appId: 1, conversationId: 1, status }],
          }
          await work({
            select: () => query,
            update: (table: unknown) => ({
              set: (values: { status: string }) => ({
                where: async () => {
                  order.push(table === agentRuns ? 'run-update' : 'message-update')
                  if (table === agentRuns) nextStatus = values.status
                },
              }),
            }),
          })
          status = nextStatus
          order.push('commit')
        },
      },
    }
    const queue = {
      sealSteerIntake: vi
        .fn()
        .mockRejectedValueOnce(new Error('Redis temporarily unavailable'))
        .mockImplementation(async () => {
          order.push('seal')
        }),
      allItems: vi.fn().mockResolvedValue([]),
      finishRun: vi.fn().mockResolvedValue(undefined),
      listAppIds: vi.fn().mockResolvedValue([]),
    }
    const module = await Test.createTestingModule({
      providers: [
        { provide: DbService, useValue: database },
        { provide: MessageQueueStore, useValue: queue },
        {
          provide: RunsService,
          inject: [DbService, MessageQueueStore],
          useFactory: (db: DbService, store: MessageQueueStore) =>
            new RunsService(
              {} as never,
              db,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              { recordActivity: vi.fn().mockResolvedValue(undefined) } as never,
              {} as never,
              store,
            ),
        },
      ],
    }).compile()
    const service = module.get(RunsService)
    await expect(
      service.finalize(
        'run-1',
        { status: 'failed', text: '', stepCount: 1, repairCount: 0 },
        undefined,
        assistantMessage('run-1'),
      ),
    ).rejects.toThrow('Redis temporarily unavailable')
    expect(status).toBe('running')
    expect(order).toEqual([])
    await (service as unknown as { dispatchQueues(): Promise<void> }).dispatchQueues()
    expect(status).toBe('failed')
    expect(order).toEqual(['seal', 'run-update', 'message-update', 'commit'])
    expect(queue.finishRun).toHaveBeenCalledWith(1, 'run-1', 'failed')
    await module.close()
  })

  it('returns a claimed item without creating a run when shutdown happens during an awaited lookup', async () => {
    let releaseLookup!: (value: unknown[]) => void
    const lookup = new Promise<unknown[]>((resolve) => {
      releaseLookup = resolve
    })
    const transaction = vi.fn()
    const database = {
      db: {
        transaction,
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () => (table === apps ? lookup : Promise.resolve([])),
            }),
          }),
        }),
      },
    }
    const queue = {
      snapshot: vi.fn().mockResolvedValue({ paused: false, items: [], activeRun: null }),
      claimNormal: vi.fn().mockResolvedValue({ id: 'queued-1' }),
      releaseNormal: vi.fn().mockResolvedValue(undefined),
    }
    const module = await Test.createTestingModule({
      providers: [
        { provide: DbService, useValue: database },
        { provide: MessageQueueStore, useValue: queue },
        {
          provide: RunsService,
          inject: [DbService, MessageQueueStore],
          useFactory: (db: DbService, store: MessageQueueStore) =>
            new RunsService(
              {} as never,
              db,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              store,
            ),
        },
      ],
    }).compile()
    const service = module.get(RunsService)
    const dispatch = (service as unknown as { dispatchQueue(appId: number): Promise<void> }).dispatchQueue(1)
    service.onModuleDestroy()
    releaseLookup([{ id: 1, ownerId: 1, status: 'active' }])
    await dispatch
    expect(transaction).not.toHaveBeenCalled()
    expect(queue.releaseNormal).toHaveBeenCalledWith(1, 'queued-1')
    await module.close()
  })
})
