import { Test, type TestingModule } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { ApiException } from '../src/common/api'
import { RedisService } from '../src/redis/redis.module'
import { MessageQueueStore } from '../src/runs/message-queue.store'

type EvalOptions = { keys: string[]; arguments: string[] }

class MemoryRedisService {
  private readonly values = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()

  readonly client = {
    get: async (key: string) => this.values.get(key) ?? null,
    sMembers: async (key: string) => [...(this.sets.get(key) ?? [])],
    eval: async (script: string, options: EvalOptions): Promise<number> => {
      if (script.includes("redis.call('SET', KEYS[1], ARGV[2])")) {
        const current = this.values.get(options.keys[0]) ?? ''
        if (current !== options.arguments[0]) return 0
        this.values.set(options.keys[0], options.arguments[1])
        this.addMember(options.keys[1], options.arguments[2])
        return 1
      }
      if (script.includes("redis.call('DEL', KEYS[1])")) {
        this.values.delete(options.keys[0])
        this.sets.get(options.keys[1])?.delete(options.arguments[0])
        return 1
      }
      throw new Error('未支持的测试 Lua 脚本')
    },
  }

  async ensureConnected() {
    return this.client
  }

  private addMember(key: string, member: string) {
    const members = this.sets.get(key) ?? new Set<string>()
    members.add(member)
    this.sets.set(key, members)
  }
}

async function setup() {
  const redis = new MemoryRedisService()
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      {
        provide: MessageQueueStore,
        useFactory: (redisService: RedisService) => new MessageQueueStore(redisService),
        inject: [RedisService],
      },
      {
        provide: RedisService,
        useValue: redis,
      },
    ],
  }).compile()
  return { store: module.get(MessageQueueStore), module, redis }
}

describe('MessageQueueStore', () => {
  it('seals failed-run intake before terminal persistence while retaining the unconsumed batch', async () => {
    const { store, module } = await setup()
    await store.openRun(1, 'run-1')
    await store.enqueue(1, {
      message: '未生效插话',
      clientRequestId: 'before-seal',
      mode: 'steer',
      runId: 'run-1',
    })
    await store.claimSteers(1, 'run-1')
    await store.sealSteerIntake(1, 'run-1')
    await expect(
      store.enqueue(1, {
        message: '过晚的插话',
        clientRequestId: 'after-seal',
        mode: 'steer',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ status: 409 })
    await store.openRun(1, 'run-1')
    await expect(
      store.enqueue(1, {
        message: '仍然过晚',
        clientRequestId: 'after-reopen',
        mode: 'steer',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ status: 409 })
    await store.finishRun(1, 'run-1', 'failed')
    expect((await store.snapshot(1)).items).toMatchObject([
      { clientRequestId: 'before-seal', status: 'returned' },
    ])
    await module.close()
  })

  it('rejects excess pending items without dropping accepted messages or breaking idempotency', async () => {
    const { store, module } = await setup()
    await store.pause(1)
    for (let index = 0; index < 100; index += 1) {
      await store.enqueue(1, {
        message: `消息 ${index}`,
        clientRequestId: `capacity-${index}`,
        mode: 'normal',
      })
    }
    await expect(
      store.enqueue(1, { message: '超额消息', clientRequestId: 'capacity-overflow', mode: 'normal' }),
    ).rejects.toMatchObject({ status: 429 })
    expect((await store.snapshot(1)).items).toHaveLength(100)
    expect(
      (await store.enqueue(1, { message: '消息 0', clientRequestId: 'capacity-0', mode: 'normal' })).message,
    ).toBe('消息 0')
    await module.close()
  })

  it('uses CAS to keep concurrent duplicate enqueue idempotent', async () => {
    const { store, module } = await setup()
    const request = {
      message: '同一条消息',
      clientRequestId: 'request-1',
      mode: 'normal' as const,
    }

    const results = await Promise.all(Array.from({ length: 20 }, () => store.enqueue(1, request)))

    expect(new Set(results.map((item) => item.id)).size).toBe(1)
    expect(await store.allItems(1)).toHaveLength(1)
    await module.close()
  })

  it('rejects a different payload that reuses the same clientRequestId', async () => {
    const { store, module } = await setup()
    await store.enqueue(1, { message: '第一条', clientRequestId: 'same', mode: 'normal' })

    await expect(
      store.enqueue(1, { message: '另一条', clientRequestId: 'same', mode: 'normal' }),
    ).rejects.toMatchObject<Partial<ApiException>>({ status: 409 })
    await store.finishRun(1, 'run-1', 'completed')
    await store.openRun(1, 'run-1')
    await expect(
      store.enqueue(1, {
        message: 'replayed',
        clientRequestId: 'replayed',
        mode: 'steer',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject<Partial<ApiException>>({ status: 409 })
    await module.close()
  })

  it('claims normal messages in FIFO order and respects pause', async () => {
    const { store, module } = await setup()
    const first = await store.enqueue(1, { message: '一', clientRequestId: 'n1', mode: 'normal' })
    await store.enqueue(1, { message: '二', clientRequestId: 'n2', mode: 'normal' })
    await store.enqueue(1, { message: '三', clientRequestId: 'n3', mode: 'normal' })

    await store.pause(1)
    expect(await store.claimNormal(1)).toBeNull()
    expect((await store.resume(1)).paused).toBe(false)

    expect((await store.claimNormal(1))?.id).toBe(first.id)
    expect((await store.claimNormal(1))?.id).toBe(first.id)
    await store.releaseNormal(1, first.id)
    expect((await store.claimNormal(1))?.clientRequestId).toBe('n1')
    await store.ackNormal(1, first.id, 'run-1')

    const snapshot = await store.snapshot(1)
    expect(snapshot.items.map((item) => item.clientRequestId)).toEqual(['n2', 'n3'])
    expect((await store.claimNormal(1))?.clientRequestId).toBe('n2')
    await module.close()
  })

  it('keeps claimed steer batches and closes intake with an atomic CAS decision', async () => {
    const { store, module } = await setup()
    await store.openRun(1, 'run-1')
    for (let index = 0; index < 25; index += 1) {
      await store.enqueue(1, {
        message: `steer-${index}`,
        clientRequestId: `s${index}`,
        mode: 'steer',
        runId: 'run-1',
      })
    }

    const claimed = await store.claimSteers(1, 'run-1')
    expect(claimed).toHaveLength(25)
    expect(claimed.every((item) => item.status === 'claimed')).toBe(true)
    await store.enqueue(1, {
      message: 'next-boundary',
      clientRequestId: 'next-boundary',
      mode: 'steer',
      runId: 'run-1',
    })
    expect((await store.claimSteers(1, 'run-1')).map((item) => item.id)).toEqual(
      claimed.map((item) => item.id),
    )
    await store.ackSteers(
      1,
      'run-1',
      claimed.slice(0, 24).map((item) => item.id),
    )

    expect(await store.closeSteerIntake(1, 'run-1')).toBe(false)
    await store.ackSteers(1, 'run-1', [claimed[24].id])
    const nextBatch = await store.claimSteers(1, 'run-1')
    expect(nextBatch.map((item) => item.clientRequestId)).toEqual(['next-boundary'])
    expect(await store.closeSteerIntake(1, 'run-1')).toBe(false)
    await store.ackSteers(
      1,
      'run-1',
      nextBatch.map((item) => item.id),
    )
    expect(await store.closeSteerIntake(1, 'run-1')).toBe(true)
    await store.openRun(1, 'run-1')
    await expect(
      store.enqueue(1, {
        message: 'late',
        clientRequestId: 'late',
        mode: 'steer',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject<Partial<ApiException>>({ status: 409 })
    await module.close()
  })

  it('serializes enqueue and closeSteerIntake without accepting after close', async () => {
    const { store, module } = await setup()
    await store.openRun(1, 'run-1')

    const [closeResult, enqueueResult] = await Promise.allSettled([
      store.closeSteerIntake(1, 'run-1'),
      store.enqueue(1, {
        message: 'racy',
        clientRequestId: 'racy',
        mode: 'steer',
        runId: 'run-1',
      }),
    ])

    if (closeResult.status === 'fulfilled' && closeResult.value) {
      expect(enqueueResult.status).toBe('rejected')
      expect(await store.snapshot(1)).toMatchObject({ items: [] })
    } else {
      expect(closeResult).toMatchObject({ status: 'fulfilled', value: false })
      expect(enqueueResult.status).toBe('fulfilled')
      expect((await store.snapshot(1)).items).toHaveLength(1)
    }
    await module.close()
  })

  it('rejects removing a claimed normal message', async () => {
    const { store, module } = await setup()
    const item = await store.enqueue(1, { message: 'normal', clientRequestId: 'remove', mode: 'normal' })
    await store.claimNormal(1)

    await expect(store.remove(1, item.id)).rejects.toMatchObject<Partial<ApiException>>({ status: 409 })
    await store.releaseNormal(1, item.id)
    expect((await store.remove(1, item.id)).items).toEqual([])
    await module.close()
  })

  it('rejects steer targeting a finished run and only downgrades an omitted run target', async () => {
    const { store, module } = await setup()
    await store.openRun(1, 'run-1')
    await store.finishRun(1, 'run-1', 'completed')

    await expect(
      store.enqueue(1, {
        message: 'finished target',
        clientRequestId: 'finished-target',
        mode: 'steer',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject<Partial<ApiException>>({ status: 409 })

    const downgraded = await store.enqueue(2, {
      message: 'ordinary',
      clientRequestId: 'downgraded',
      mode: 'steer',
    })
    expect(downgraded.mode).toBe('normal')
    await module.close()
  })

  it('marks a run cancelling and recovers registry state for external reconciliation', async () => {
    const { store, module } = await setup()
    const normal = await store.enqueue(2, { message: 'n', clientRequestId: 'n', mode: 'normal' })
    await store.claimNormal(2)
    await store.openRun(2, 'run-2')
    const steer = await store.enqueue(2, {
      message: 's',
      clientRequestId: 's',
      mode: 'steer',
      runId: 'run-2',
    })
    const claimedSteers = await store.claimSteers(2, 'run-2')
    await store.markCancelling(2, 'run-2')
    expect(await store.snapshot(2)).toMatchObject({ activeRun: { runId: 'run-2', status: 'cancelling' } })
    expect((await store.claimSteers(2, 'run-2')).map((item) => item.id)).toEqual(
      claimedSteers.map((item) => item.id),
    )

    expect(await store.listAppIds()).toEqual([2])
    expect((await store.allItems(2)).map((item) => item.id)).toEqual([normal.id, steer.id])
    await store.recover()
    expect(await store.snapshot(2)).toEqual({
      paused: true,
      activeRun: null,
      items: [
        { ...normal, status: 'queued', runId: null },
        { ...steer, status: 'returned' },
      ],
    })
    await module.close()
  })
})
