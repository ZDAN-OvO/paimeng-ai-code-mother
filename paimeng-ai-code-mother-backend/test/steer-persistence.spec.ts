import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { SessionStoreService } from '../src/agent/session-store.service'
import { DbService } from '../src/db/db.module'
import { agentRuns, agentSessionEntries } from '../src/db/schema'
import { assistantMessage, type AppUIMessage } from '../src/conversations/ui-message'

type StoredEntry = { seq: number; entryType: string; payload: Record<string, unknown> }

async function fixture() {
  let state = {
    entries: [
      { seq: 1, entryType: 'user', payload: { text: '开始' } },
      { seq: 2, entryType: 'assistant', payload: { text: '检查' } },
      { seq: 3, entryType: 'tool', payload: { toolCallId: 'read-1', output: 'ok' } },
    ] as StoredEntry[],
    content: assistantMessage('run-1'),
  }
  let status = 'running'
  let failSnapshot = false
  const db = {
    transaction: async (work: (tx: unknown) => Promise<void>) => {
      const staged = structuredClone(state)
      const tx = {
        select: (fields?: { next: unknown }) => ({
          from: (table: unknown) => {
            const result = () =>
              table === agentRuns
                ? [{ status }]
                : table === agentSessionEntries && fields
                  ? [{ next: Math.max(...staged.entries.map((row) => row.seq)) + 1 }]
                  : staged.entries
            const query = {
              where: () => query,
              for: () => query,
              limit: async () => result(),
              then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
            }
            return query
          },
        }),
        insert: () => ({
          values: async (row: StoredEntry) => {
            staged.entries.push(row)
          },
        }),
        update: () => ({
          set: (values: { content: AppUIMessage }) => ({
            where: () => ({
              returning: async () => {
                if (failSnapshot) throw new Error('snapshot unavailable')
                staged.content = structuredClone(values.content)
                return [{ id: 1 }]
              },
            }),
          }),
        }),
      }
      await work(tx)
      state = staged
    },
  }
  const module = await Test.createTestingModule({
    providers: [
      { provide: DbService, useValue: { db } },
      {
        provide: SessionStoreService,
        useFactory: (database: DbService) => new SessionStoreService(database),
        inject: [DbService],
      },
    ],
  }).compile()
  return {
    module,
    store: module.get(SessionStoreService),
    snapshot: () => structuredClone(state),
    stop: () => {
      status = 'cancelling'
    },
    fail: () => {
      failSnapshot = true
    },
  }
}

const batch = [
  { clientRequestId: 'steer-0001', message: 'S1' },
  { clientRequestId: 'steer-0002', message: 'S2' },
]
const content = (): AppUIMessage => ({
  ...assistantMessage('run-1'),
  parts: batch.map((item) => ({
    type: 'data-steer',
    id: `steer:${item.clientRequestId}`,
    data: { text: item.message, clientRequestId: item.clientRequestId },
  })),
})

describe('steer persistence boundary', () => {
  it('commits both steer contexts after earlier tool results and deduplicates a replayed batch', async () => {
    const test = await fixture()
    expect(test.snapshot().entries).toHaveLength(3)
    await test.store.appendSteers(1, 'run-1', batch, content())
    await test.store.appendSteers(1, 'run-1', batch, content())
    expect(test.snapshot().entries.map((row) => [row.seq, row.entryType])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'tool'],
      [4, 'user'],
      [5, 'user'],
    ])
    expect(
      test
        .snapshot()
        .entries.slice(3)
        .map((row) => row.payload.text),
    ).toEqual(['S1', 'S2'])
    expect(test.snapshot().content).toEqual(content())
    await test.module.close()
  })

  it('does not retain new contexts if saving the public snapshot fails', async () => {
    const test = await fixture()
    const before = test.snapshot()
    test.fail()
    await expect(test.store.appendSteers(1, 'run-1', batch, content())).rejects.toThrow(
      'snapshot unavailable',
    )
    expect(test.snapshot()).toEqual(before)
    await test.module.close()
  })

  it('leaves steers out of both histories when cancellation wins the run lock', async () => {
    const test = await fixture()
    const before = test.snapshot()
    test.stop()
    await expect(test.store.appendSteers(1, 'run-1', batch, content())).rejects.toMatchObject({ status: 409 })
    expect(test.snapshot()).toEqual(before)
    await test.module.close()
  })

  it('rejects a claimed batch if the in-process cancel signal is already set', async () => {
    const test = await fixture()
    const before = test.snapshot()
    const abort = new AbortController()
    abort.abort()
    await expect(test.store.appendSteers(1, 'run-1', batch, content(), abort.signal)).rejects.toMatchObject({
      status: 409,
    })
    expect(test.snapshot()).toEqual(before)
    await test.module.close()
  })
})
