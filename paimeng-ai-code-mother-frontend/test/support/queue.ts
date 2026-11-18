import assert from 'node:assert/strict'
import { createQueuedChatCoordinator } from '../../src/utils/queuedChatCoordinator.ts'
import type { QueuedChatDependencies } from '../../src/utils/queuedChatCoordinator.ts'
import type { QueueItem } from '../../src/api/chatTypes.ts'

export const coordinatorFixture = (overrides: Partial<QueuedChatDependencies> = {}) =>
  createQueuedChatCoordinator({
    appId: 7,
    createRequestId: () => 'request-1',
    enqueue: async (body) => queuedItem({ mode: body.mode, clientRequestId: body.clientRequestId }),
    getQueue: async () => ({ paused: false, items: [], activeRun: null }),
    findRunByRequest: async () => {
      throw new Error('run status unavailable')
    },
    findQueueItemByRequest: async () => null,
    remove: async () => undefined,
    resume: async () => ({ paused: false, items: [], activeRun: null }),
    cancel: async () => assert.fail('disconnecting must not cancel the run'),
    reconcile: async (runId) => ({ runId, status: 'completed', errorSummary: null }),
    subscribe: async () => undefined,
    changed: () => undefined,
    message: () => undefined,
    event: () => undefined,
    reconciled: () => undefined,
    error: () => undefined,
    pollMs: 60_000,
    ...overrides,
  })

export const queuedItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: 'queue-1',
  clientRequestId: 'request-1',
  message: '修改标题',
  mode: 'steer',
  status: 'queued',
  runId: null,
  ...overrides,
})
