import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ApiException } from '../common/api'
import { RedisService } from '../redis/redis.module'

export type QueueItem = {
  id: string
  clientRequestId: string
  message: string
  mode: 'normal' | 'steer'
  status: 'queued' | 'claimed' | 'started' | 'applied' | 'returned' | 'removed'
  runId: string | null
}

type QueueMode = QueueItem['mode']
type ActiveRun = { runId: string; status: 'running' | 'cancelling' }

type StoredQueueItem = QueueItem & {
  requestedMode: QueueMode
  requestedRunId: string | null
  seq: number
}

type QueueState = {
  version: 1
  paused: boolean
  activeRun: ActiveRun | null
  steerOpen: boolean
  closedRuns: string[]
  nextSeq: number
  items: StoredQueueItem[]
}

type QueueSnapshot = {
  paused: boolean
  items: QueueItem[]
  activeRun: ActiveRun | null
  requestedItem?: QueueItem | null
}

type EnqueueRequest = {
  message: string
  clientRequestId: string
  mode: QueueMode
  runId?: string
}

type MutationResult<T> = {
  value: T
  state?: QueueState
}

const REGISTRY_KEY = 'chat:queue:apps'
const STATE_KEY_PREFIX = 'chat:queue:app:'
const MAX_PENDING_ITEMS = 100
const MAX_STATE_BYTES = 1024 * 1024

const CAS_WRITE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
return 1
`

const CLEAR_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`

@Injectable()
export class MessageQueueStore {
  constructor(private readonly redis: RedisService) {}

  async snapshot(appId: number, clientRequestId?: string): Promise<QueueSnapshot> {
    const state = await this.readState(appId)
    const snapshot = this.toSnapshot(state)
    if (clientRequestId !== undefined) {
      const item = state.items.find((entry) => entry.clientRequestId === clientRequestId)
      snapshot.requestedItem = item ? this.toQueueItem(item) : null
    }
    return snapshot
  }

  async enqueue(appId: number, request: EnqueueRequest): Promise<QueueItem> {
    const id = randomUUID()
    return this.mutate(appId, (state) => {
      const existing = state.items.find((item) => item.clientRequestId === request.clientRequestId)
      const requestedRunId = request.runId ?? null
      if (existing) {
        if (
          existing.message !== request.message ||
          existing.requestedMode !== request.mode ||
          existing.requestedRunId !== requestedRunId
        ) {
          throw ApiException.conflict('clientRequestId 已用于另一条内容不同的队列消息')
        }
        return { value: this.toQueueItem(existing) }
      }
      if (
        state.items.filter((item) => ['queued', 'claimed', 'returned'].includes(item.status)).length >=
        MAX_PENDING_ITEMS
      ) {
        throw ApiException.rateLimited('待处理消息已达 100 条，请先处理或移除队列中的消息')
      }

      let mode: QueueMode = request.mode
      let runId: string | null = null
      if (request.mode === 'steer') {
        if (requestedRunId === null) {
          if (state.activeRun) throw ApiException.conflict('插话消息必须指定当前运行')
          mode = 'normal'
        } else {
          if (!state.activeRun || state.activeRun.runId !== requestedRunId) {
            throw ApiException.conflict('插话消息指定的运行已结束或不是当前运行')
          }
          if (!state.steerOpen) throw ApiException.conflict('当前运行已关闭插话接收')
          runId = requestedRunId
        }
      }

      const item: StoredQueueItem = {
        id,
        clientRequestId: request.clientRequestId,
        message: request.message,
        mode,
        status: 'queued',
        runId,
        requestedMode: request.mode,
        requestedRunId,
        seq: state.nextSeq,
      }
      state.nextSeq += 1
      state.items.push(item)
      if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) {
        throw ApiException.rateLimited('此应用的消息队列存储空间已满，请创建新应用继续')
      }
      return { value: this.toQueueItem(item), state }
    })
  }

  async openRun(appId: number, runId: string): Promise<void> {
    await this.mutate(appId, (state) => {
      if (state.activeRun?.runId === runId || state.closedRuns.includes(runId)) {
        return { value: undefined }
      }
      if (state.activeRun) throw ApiException.conflict('应用已有运行中的队列会话')
      state.activeRun = { runId, status: 'running' }
      state.steerOpen = true
      return { value: undefined, state }
    })
  }

  async markCancelling(appId: number, runId: string): Promise<void> {
    await this.mutate(appId, (state) => {
      if (state.activeRun?.runId !== runId) return { value: undefined }
      if (state.activeRun.status === 'cancelling' && !state.steerOpen && state.paused)
        return { value: undefined }
      state.activeRun.status = 'cancelling'
      state.steerOpen = false
      state.paused = true
      return { value: undefined, state }
    })
  }

  async sealSteerIntake(appId: number, runId: string): Promise<void> {
    await this.mutate(appId, (state) => {
      if (state.activeRun?.runId !== runId || !state.steerOpen) return { value: undefined }
      state.steerOpen = false
      return { value: undefined, state }
    })
  }

  async claimNormal(appId: number): Promise<QueueItem | null> {
    return this.mutate(appId, (state) => {
      if (state.paused || state.activeRun) return { value: null }
      const existing = state.items.find((item) => item.mode === 'normal' && item.status === 'claimed')
      if (existing) return { value: this.toQueueItem(existing) }
      const next = state.items.find((item) => item.mode === 'normal' && item.status === 'queued')
      if (!next) return { value: null }
      next.status = 'claimed'
      return { value: this.toQueueItem(next), state }
    })
  }

  async releaseNormal(appId: number, id: string): Promise<void> {
    await this.mutate(appId, (state) => {
      const item = this.findByQueueId(state, id)
      if (!item || item.mode !== 'normal' || item.status !== 'claimed') return { value: undefined }
      item.status = 'queued'
      item.runId = null
      return { value: undefined, state }
    })
  }

  async ackNormal(appId: number, id: string, runId: string): Promise<void> {
    await this.mutate(appId, (state) => {
      const item = this.findByQueueId(state, id)
      if (!item || item.mode !== 'normal') return { value: undefined }
      if (item.status === 'started') {
        if (item.runId === runId) return { value: undefined }
        throw ApiException.conflict('队列消息已绑定另一条运行')
      }
      if (item.status !== 'claimed' && item.status !== 'queued') return { value: undefined }
      item.status = 'started'
      item.runId = runId
      return { value: undefined, state }
    })
  }

  async claimSteers(appId: number, runId: string): Promise<QueueItem[]> {
    return this.mutate(appId, (state) => {
      if (state.activeRun?.runId !== runId) return { value: [] }
      const claimed = state.items.filter(
        (item) => item.mode === 'steer' && item.runId === runId && item.status === 'claimed',
      )
      if (claimed.length > 0) {
        return { value: claimed.map((item) => this.toQueueItem(item)) }
      }
      if (!state.steerOpen) return { value: [] }
      const queued = state.items.filter(
        (item) => item.mode === 'steer' && item.runId === runId && item.status === 'queued',
      )
      for (const item of queued) item.status = 'claimed'
      return {
        value: queued.map((item) => this.toQueueItem(item)),
        state: queued.length > 0 ? state : undefined,
      }
    })
  }

  async ackSteers(appId: number, runId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const targetIds = new Set(ids)
    await this.mutate(appId, (state) => {
      let changed = false
      for (const item of state.items) {
        if (
          targetIds.has(item.id) &&
          item.mode === 'steer' &&
          item.runId === runId &&
          item.status === 'claimed'
        ) {
          item.status = 'applied'
          changed = true
        }
      }
      return { value: undefined, state: changed ? state : undefined }
    })
  }

  async closeSteerIntake(appId: number, runId: string): Promise<boolean> {
    return this.mutate(appId, (state) => {
      if (state.activeRun?.runId !== runId) return { value: false }
      const pending = state.items.some(
        (item) =>
          item.mode === 'steer' &&
          item.runId === runId &&
          (item.status === 'queued' || item.status === 'claimed'),
      )
      if (pending) return { value: false }
      if (!state.steerOpen) return { value: true }
      state.steerOpen = false
      return { value: true, state }
    })
  }

  async finishRun(appId: number, runId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    await this.mutate(appId, (state) => {
      if (state.closedRuns.includes(runId)) return { value: undefined }
      state.closedRuns.push(runId)
      if (state.activeRun?.runId === runId) {
        state.activeRun = null
        state.steerOpen = false
      }
      for (const item of state.items) {
        if (
          item.mode === 'steer' &&
          item.runId === runId &&
          (item.status === 'queued' || item.status === 'claimed')
        ) {
          item.status = 'returned'
        }
      }
      if (status !== 'completed' && !state.paused) {
        state.paused = true
      }
      return { value: undefined, state }
    })
  }

  async pause(appId: number): Promise<void> {
    await this.mutate(appId, (state) => {
      if (state.paused) return { value: undefined }
      state.paused = true
      return { value: undefined, state }
    })
  }

  async resume(appId: number): Promise<QueueSnapshot> {
    return this.mutate(appId, (state) => {
      if (!state.paused) return { value: this.toSnapshot(state) }
      state.paused = false
      return { value: this.toSnapshot(state), state }
    })
  }

  async remove(appId: number, id: string): Promise<QueueSnapshot> {
    return this.mutate(appId, (state) => {
      const item = this.findByQueueId(state, id)
      if (!item) return { value: this.toSnapshot(state) }
      if (item.status === 'removed') return { value: this.toSnapshot(state) }
      if (item.status === 'claimed') throw ApiException.conflict('已认领的队列消息不能移除')
      if (item.status !== 'queued' && item.status !== 'returned') {
        throw ApiException.conflict('当前状态的队列消息不能移除')
      }
      item.status = 'removed'
      return { value: this.toSnapshot(state), state }
    })
  }

  async recover(): Promise<void> {
    const appIds = await this.listAppIds()
    for (const appId of appIds) {
      await this.mutate(appId, (state) => {
        state.paused = true
        state.activeRun = null
        state.steerOpen = false
        for (const item of state.items) {
          if (item.mode === 'normal' && item.status === 'claimed') {
            item.status = 'queued'
            item.runId = null
          } else if (item.mode === 'steer' && (item.status === 'queued' || item.status === 'claimed')) {
            item.status = 'returned'
          }
        }
        return { value: undefined, state }
      })
    }
  }

  async clear(appId: number): Promise<void> {
    const client = await this.redis.ensureConnected()
    await client.eval(CLEAR_SCRIPT, {
      keys: [this.stateKey(appId), REGISTRY_KEY],
      arguments: [String(appId)],
    })
  }

  async listAppIds(): Promise<number[]> {
    const client = await this.redis.ensureConnected()
    const members = await client.sMembers(REGISTRY_KEY)
    return members
      .map((member) => Number(member))
      .filter((appId) => Number.isSafeInteger(appId) && appId > 0)
      .sort((left, right) => left - right)
  }

  async allItems(appId: number): Promise<QueueItem[]> {
    return (await this.readState(appId)).items
      .sort((left, right) => left.seq - right.seq)
      .map((item) => this.toQueueItem(item))
  }

  private async mutate<T>(appId: number, reduce: (state: QueueState) => MutationResult<T>): Promise<T> {
    const client = await this.redis.ensureConnected()
    const key = this.stateKey(appId)
    for (;;) {
      const raw = await client.get(key)
      const state = raw ? this.parseState(raw) : this.emptyState()
      const result = reduce(state)
      if (!result.state) return result.value
      const next = JSON.stringify(result.state)
      const written = await client.eval(CAS_WRITE_SCRIPT, {
        keys: [key, REGISTRY_KEY],
        arguments: [raw ?? '', next, String(appId)],
      })
      if (Number(written) === 1) return result.value
    }
  }

  private async readState(appId: number): Promise<QueueState> {
    const client = await this.redis.ensureConnected()
    const raw = await client.get(this.stateKey(appId))
    return raw ? this.parseState(raw) : this.emptyState()
  }

  private parseState(raw: string): QueueState {
    return JSON.parse(raw) as QueueState
  }

  private emptyState(): QueueState {
    return {
      version: 1,
      paused: false,
      activeRun: null,
      steerOpen: false,
      closedRuns: [],
      nextSeq: 0,
      items: [],
    }
  }

  private toSnapshot(state: QueueState): QueueSnapshot {
    return {
      paused: state.paused,
      activeRun: state.activeRun ? { ...state.activeRun } : null,
      items: state.items
        .filter((item) => item.status === 'queued' || item.status === 'claimed' || item.status === 'returned')
        .sort((left, right) => left.seq - right.seq)
        .map((item) => this.toQueueItem(item)),
    }
  }

  private toQueueItem(item: StoredQueueItem): QueueItem {
    return {
      id: item.id,
      clientRequestId: item.clientRequestId,
      message: item.message,
      mode: item.mode,
      status: item.status,
      runId: item.runId,
    }
  }

  private findByQueueId(state: QueueState, id: string): StoredQueueItem | undefined {
    return state.items.find((item) => item.id === id)
  }

  private stateKey(appId: number): string {
    return `${STATE_KEY_PREFIX}${appId}`
  }
}
