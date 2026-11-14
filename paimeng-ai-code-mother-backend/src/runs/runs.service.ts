import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { AppConfigService } from '../config/config.module'
import { ApiException } from '../common/api'
import {
  appendText,
  AppUIMessage,
  assistantMessage,
  finishMessage,
  messageText,
  userMessage,
} from '../conversations/types'
import {
  replayMessageChunks,
  type AppUIMessageChunk,
  UIMessageAccumulator,
  UIMessageEmitter,
} from '../conversations/ui-message'
import { DbService } from '../db/db.module'
import { agentRuns, agentSessionEntries, apps, conversations, messages, RunRow } from '../db/schema'
import { RedisService } from '../redis/redis.module'
import { AppsService } from '../apps/apps.service'
import { AgentService } from '../agent/agent.service'
import { SessionStoreService } from '../agent/session-store.service'
import { RunStream } from './run-stream'
import { ChangeSummary, RunDetailsService } from './run-details.service'
import { AppMutexService } from '../runtime/app-mutex.service'
import { RuntimeService } from '../runtime/runtime.service'

export interface StartRunResult {
  runId: string
  reused: boolean
}

interface ActiveRun {
  abort: AbortController
  startedAt: number
}

const TERMINAL = ['completed', 'failed', 'cancelled'] as const

@Injectable()
export class RunsService implements OnModuleDestroy {
  private readonly logger = new Logger(RunsService.name)
  private readonly streams = new Map<string, RunStream>()
  private readonly active = new Map<string, ActiveRun>()

  constructor(
    private readonly config: AppConfigService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly appsService: AppsService,
    private readonly agent: AgentService,
    private readonly sessionStore: SessionStoreService,
    private readonly runtime: RuntimeService,
    private readonly details: RunDetailsService,
    private readonly mutex: AppMutexService,
  ) {}

  onModuleDestroy() {
    for (const run of this.active.values()) run.abort.abort()
  }

  getStream(runId: string) {
    return this.streams.get(runId) ?? null
  }

  async startRun(
    userId: number,
    appId: number,
    message: string,
    clientRequestId: string,
  ): Promise<StartRunResult> {
    await this.appsService.assertCanRun(appId, userId)
    const existing = await this.findByClientRequestId(appId, clientRequestId)
    if (existing) return this.reuseRunResult(existing, message)

    const [conversation] = await this.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.appId, appId))
      .limit(1)
    if (!conversation) throw ApiException.notFound('应用会话不存在')

    const runId = randomUUID()
    const deadlineAt = new Date(Date.now() + this.config.runMaxDurationMs)
    await this.consumeRateLimit(appId)

    try {
      await this.db.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${userId})`)
        const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update').limit(1)
        if (!app || app.ownerId !== userId) throw ApiException.notFound('应用不存在')
        if (app.status !== 'active') throw ApiException.conflict('应用正在删除，无法执行任务')
        if (app.execBlocked) throw ApiException.conflict('应用存在未确认停止的任务容器，暂时无法执行')

        const [activeRun] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.appId, appId), inArray(agentRuns.status, ['running', 'cancelling'])))
          .limit(1)
        if (activeRun) {
          if (activeRun.clientRequestId === clientRequestId) throw new DuplicateRunError(activeRun)
          throw ApiException.conflict('应用已有运行中的任务，请等待完成或先取消')
        }

        await this.details.assertQuota(appId, tx)

        const [sameRequest] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.appId, appId), eq(agentRuns.clientRequestId, clientRequestId)))
          .limit(1)
        if (sameRequest) throw new DuplicateRunError(sameRequest)

        const activeApps = await tx
          .select({ value: sql<number>`count(distinct ${agentRuns.appId})` })
          .from(agentRuns)
          .innerJoin(apps, eq(apps.id, agentRuns.appId))
          .where(
            and(
              eq(apps.ownerId, userId),
              inArray(agentRuns.status, ['running', 'cancelling']),
              eq(apps.status, 'active'),
            ),
          )
        if (Number(activeApps[0]?.value ?? 0) >= this.config.maxRunsPerUser) {
          throw ApiException.conflict(
            `同时运行的应用已达上限（${this.config.maxRunsPerUser} 个），请等待已有任务结束`,
          )
        }

        await tx.insert(messages).values({
          conversationId: conversation.id,
          runId,
          role: 'user',
          status: 'completed',
          content: userMessage(runId, message),
        })

        await tx.insert(agentRuns).values({
          id: runId,
          appId,
          conversationId: conversation.id,
          clientRequestId,
          status: 'running',
          phase: 'prepare',
          startedAt: new Date(),
          deadlineAt,
        })

        await tx.insert(messages).values({
          conversationId: conversation.id,
          runId,
          role: 'assistant',
          status: 'streaming',
          content: assistantMessage(runId),
        })

        const [{ next }] = await tx
          .select({ next: sql<number>`coalesce(max(${agentSessionEntries.seq}), 0) + 1` })
          .from(agentSessionEntries)
          .where(eq(agentSessionEntries.conversationId, conversation.id))
        await tx.insert(agentSessionEntries).values({
          conversationId: conversation.id,
          runId,
          seq: Number(next),
          entryType: 'user',
          payload: { text: message },
        })
      })
    } catch (err) {
      if (err instanceof DuplicateRunError) {
        const run = await this.findByClientRequestId(appId, clientRequestId)
        if (!run) throw ApiException.conflict('重复请求处理失败')
        return this.reuseRunResult(run, message)
      }
      throw err
    }

    const abort = new AbortController()
    this.active.set(runId, { abort, startedAt: Date.now() })
    try {
      await this.mutex.withLock(appId, () => this.details.ensureBaseline(runId, appId))
    } catch (err) {
      this.active.delete(runId)
      const message = err instanceof Error ? err.message : String(err)
      await this.finalize(
        runId,
        {
          status: 'failed',
          text: '',
          stepCount: 0,
          repairCount: 0,
          errorCode: 'DETAILS_BASELINE_FAILED',
          errorSummary: `运行详情基线创建失败：${message}`,
        },
        { detailsStatus: 'incomplete', detailsError: message, changes: null },
      )
      throw ApiException.conflict(`无法创建本轮文件快照：${message}`)
    }

    const stream = new RunStream(runId)
    this.streams.set(runId, stream)
    const [current] = await this.db.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (abort.signal.aborted || ['cancelling', 'cancelled'].includes(current?.status ?? '')) {
      this.active.delete(runId)
      await this.finalize(runId, {
        status: 'cancelled',
        text: '',
        stepCount: 0,
        repairCount: 0,
        errorCode: 'CANCELLED',
        errorSummary: '任务已取消',
      })
      return { runId, reused: false }
    }
    void this.executeRun({
      runId,
      appId,
      userId,
      conversationId: conversation.id,
      deadlineAt,
      stream,
      abort,
    }).catch((err) => {
      this.logger.error(`运行 ${runId} 后台任务失败: ${err instanceof Error ? err.stack : String(err)}`)
    })
    return { runId, reused: false }
  }

  private async reuseRunResult(run: RunRow, message: string): Promise<StartRunResult> {
    const [stored] = await this.db.db
      .select()
      .from(messages)
      .where(and(eq(messages.runId, run.id), eq(messages.role, 'user')))
      .limit(1)
    if (stored) {
      const text = messageText(stored.content as AppUIMessage)
      if (text !== message) {
        throw ApiException.conflict('clientRequestId 已用于另一条内容不同的消息')
      }
    }
    return { runId: run.id, reused: true }
  }

  private async findByClientRequestId(appId: number, clientRequestId: string) {
    const [row] = await this.db.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.appId, appId), eq(agentRuns.clientRequestId, clientRequestId)))
      .limit(1)
    return row ?? null
  }

  private async consumeRateLimit(appId: number) {
    const client = await this.redis.ensureConnected()
    const key = `rate:app:${appId}`
    const now = Date.now()
    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local member = ARGV[3]
      redis.call('ZREMRANGEBYSCORE', key, 0, now - 60000)
      local count = redis.call('ZCARD', key)
      if count >= limit then return 0 end
      redis.call('ZADD', key, now, member)
      redis.call('PEXPIRE', key, 120000)
      return 1
    `
    try {
      const allowed = await client.eval(script, {
        keys: [key],
        arguments: [String(now), String(this.config.appRateLimitPerMinute), `${now}-${randomUUID()}`],
      })
      if (Number(allowed) !== 1) {
        throw ApiException.rateLimited(
          `请求过于频繁：每个应用每分钟最多 ${this.config.appRateLimitPerMinute} 次`,
        )
      }
    } catch (err) {
      if (err instanceof ApiException) throw err
      throw ApiException.unavailable('限流服务不可用，请稍后重试')
    }
  }

  private async executeRun(params: {
    runId: string
    appId: number
    userId: number
    conversationId: number
    deadlineAt: Date
    stream: RunStream
    abort: AbortController
  }) {
    const { abort } = params
    let liveText = ''
    const accumulator = new UIMessageAccumulator(params.runId)
    const emitter = new UIMessageEmitter(params.runId, (chunk) => {
      accumulator.write(chunk)
      params.stream.emit(chunk)
    })
    emitter.start()
    let persistChain: Promise<void> = Promise.resolve()
    let flushTimer: NodeJS.Timeout | null = null
    let persistedBytes = 0
    const persistAssistant = () => {
      persistedBytes = Buffer.byteLength(liveText, 'utf8')
      persistChain = persistChain
        .then(async () => this.updateAssistantContent(params.runId, await accumulator.snapshot()))
        .catch((err) => {
          this.logger.warn(
            `运行 ${params.runId} 工具/验证摘要落库失败: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
    }
    const schedulePersist = (immediately = false) => {
      if (immediately) {
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = null
        persistAssistant()
        return
      }
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        persistAssistant()
      }, 500)
      flushTimer.unref?.()
    }
    const emit = (type: string, payload?: Record<string, unknown>) => {
      const changed = emitter.emit(type, payload)
      if (type === 'text-delta') {
        liveText += String(payload?.text ?? '')
        if (Buffer.byteLength(liveText, 'utf8') - persistedBytes >= 8 * 1024) schedulePersist(true)
        else schedulePersist()
        return
      }
      if (type === 'model-status' && payload?.status === 'streaming') return
      void this.details
        .recordActivity(params.runId, params.appId, type, payload ?? {})
        .catch((err) =>
          this.logger.warn(
            `运行 ${params.runId} 活动记录失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      if (changed) schedulePersist(true)
    }
    let outcome: Awaited<ReturnType<AgentService['execute']>>
    try {
      outcome = await this.agent.execute({
        runId: params.runId,
        appId: params.appId,
        conversationId: params.conversationId,
        deadlineAt: params.deadlineAt,
        signal: abort.signal,
        emit,
        setPhase: (phase) => {
          void this.updatePhase(params.runId, phase)
          emitter.emit('phase', { phase })
          void this.details
            .recordActivity(params.runId, params.appId, 'phase', { phase })
            .catch(() => undefined)
        },
        onStep: (stepCount) => void this.updateStepCount(params.runId, stepCount),
        isCancelled: () => abort.signal.aborted,
      })
    } catch (err) {
      this.logger.error(`运行 ${params.runId} 异常结束: ${err instanceof Error ? err.stack : String(err)}`)
      outcome = {
        status: 'failed',
        text: liveText,
        stepCount: 0,
        repairCount: 0,
        errorCode: 'INTERNAL_ERROR',
        errorSummary: err instanceof Error ? err.message : String(err),
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      persistAssistant()
      await persistChain
      this.active.delete(params.runId)
    }
    let detailsStatus: 'ready' | 'incomplete' = 'ready'
    let detailsError: string | null = null
    let changes: ChangeSummary | null = null
    try {
      changes = await this.mutex.withLock(params.appId, () =>
        this.details.finalizeRun(params.runId, params.appId),
      )
      if (changes.partial) {
        detailsStatus = 'incomplete'
        detailsError = '部分文件变更无法计算完整 diff'
      }
    } catch (err) {
      detailsStatus = 'incomplete'
      detailsError = err instanceof Error ? err.message : String(err)
      this.logger.warn(`运行 ${params.runId} 详情收尾失败: ${detailsError}`)
    }
    try {
      if (!liveText) {
        emitter.emit('text-delta', { text: outcome.text || outcome.errorSummary || '' })
      }
      emitter.closeText()
      const finalContent = finishMessage(await accumulator.snapshot(), params.runId, outcome.status)
      await this.updateAssistantContent(params.runId, finalContent)
      await this.finalize(
        params.runId,
        outcome,
        {
          detailsStatus,
          detailsError,
          changes,
        },
        finalContent,
        emitter,
      )
    } catch (err) {
      this.logger.error(`运行 ${params.runId} 收尾失败: ${err instanceof Error ? err.stack : String(err)}`)
    } finally {
      await accumulator.close()
    }
  }

  private async updateStepCount(runId: string, stepCount: number) {
    await this.db.db
      .update(agentRuns)
      .set({ stepCount })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['running', 'cancelling'])))
  }

  private async updatePhase(runId: string, phase: string) {
    await this.db.db
      .update(agentRuns)
      .set({ phase })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['running', 'cancelling'])))
  }

  private async updateAssistantContent(runId: string, content: AppUIMessage) {
    await this.db.db
      .update(messages)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(messages.runId, runId), eq(messages.role, 'assistant'), eq(messages.status, 'streaming')))
  }

  async finalize(
    runId: string,
    outcome: {
      status: 'completed' | 'failed' | 'cancelled'
      text: string
      stepCount: number
      repairCount: number
      errorCode?: string
      errorSummary?: string
    },
    details?: {
      detailsStatus: 'ready' | 'incomplete'
      detailsError: string | null
      changes: ChangeSummary | null
    },
    content?: AppUIMessage,
    emitter?: UIMessageEmitter,
  ) {
    const stream = this.streams.get(runId)
    let finalStatus = outcome.status
    let finalErrorCode = outcome.errorCode
    let finalErrorSummary = outcome.errorSummary
    let runAppId = 0
    if (finalStatus === 'cancelled') {
      finalErrorCode = finalErrorCode ?? 'CANCELLED'
      finalErrorSummary = finalErrorSummary ?? '任务已取消'
    }
    let alreadyFinal = false
    await this.db.db.transaction(async (tx) => {
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for('update').limit(1)
      if (!run) {
        alreadyFinal = true
        return
      }
      runAppId = run.appId
      if ((TERMINAL as readonly string[]).includes(run.status)) {
        alreadyFinal = true
        return
      }
      if (run.status === 'cancelling') {
        finalStatus = 'cancelled'
        finalErrorCode = 'CANCELLED'
        finalErrorSummary = '任务已取消'
      }
      let finalContent = content
      if (!finalContent) {
        const [assistant] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.runId, runId), eq(messages.role, 'assistant')))
          .limit(1)
        const stored = assistant?.content as AppUIMessage | undefined
        finalContent = finishMessage(stored, runId, finalStatus, outcome.text || finalErrorSummary)
      }
      await tx
        .update(agentRuns)
        .set({
          status: finalStatus,
          phase: 'finish',
          stepCount: outcome.stepCount,
          repairCount: outcome.repairCount,
          errorCode: finalErrorCode ?? null,
          errorSummary: finalErrorSummary ?? null,
          detailsStatus: details ? details.detailsStatus : 'incomplete',
          detailsError: details ? details.detailsError : '运行详情在收尾前未准备完成',
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId))
      await tx
        .update(messages)
        .set({
          status: finalStatus,
          content: finalContent,
          updatedAt: new Date(),
        })
        .where(
          and(eq(messages.runId, runId), eq(messages.role, 'assistant'), eq(messages.status, 'streaming')),
        )
    })
    if (alreadyFinal) {
      stream?.finish()
      return
    }
    const finishedPayload = {
      status: finalStatus,
      errorCode: finalErrorCode ?? null,
      errorSummary: finalErrorSummary ?? null,
      stepCount: outcome.stepCount,
      repairCount: outcome.repairCount,
      detailsStatus: details ? details.detailsStatus : 'incomplete',
      detailsError: details ? details.detailsError : null,
      changes: details?.changes ?? null,
    }
    if (runAppId) {
      await this.details
        .recordActivity(runId, runAppId, 'run-finished', finishedPayload)
        .catch(() => undefined)
    }
    if (emitter) emitter.finish(finishedPayload)
    else {
      const fallback = new UIMessageEmitter(runId, (chunk) => stream?.emit(chunk))
      fallback.start()
      fallback.finish(finishedPayload)
    }
    stream?.finish()
    setTimeout(() => this.streams.delete(runId), 60_000).unref?.()
  }

  async cancelRun(userId: number, runId: string) {
    const [run] = await this.db.db
      .select({ run: agentRuns, ownerId: apps.ownerId })
      .from(agentRuns)
      .innerJoin(apps, eq(apps.id, agentRuns.appId))
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (!run) throw ApiException.notFound('运行记录不存在')
    if (run.ownerId !== userId) throw ApiException.forbidden('无权操作该运行')
    if ((TERMINAL as readonly string[]).includes(run.run.status)) {
      return { runId, status: run.run.status }
    }
    const updated = await this.db.db
      .update(agentRuns)
      .set({ status: 'cancelling', cancelRequestedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
      .returning()
    if (!updated.length) {
      const [current] = await this.db.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
      return { runId, status: current?.status ?? 'cancelling' }
    }
    const active = this.active.get(runId)
    if (active) {
      active.abort.abort()
    }
    await this.runtime.stopTask(run.run.appId)
    if (await this.runtime.isTaskRunning(run.run.appId)) {
      await this.appsService.markExecBlocked(run.run.appId, true)
    }
    if (!active) {
      await this.finalize(runId, {
        status: 'cancelled',
        text: '',
        stepCount: 0,
        repairCount: 0,
        errorCode: 'CANCELLED',
        errorSummary: '任务已取消',
      })
    }
    return { runId, status: 'cancelling' }
  }

  async getRunStatus(userId: number, query: { runId?: string; appId?: number; clientRequestId?: string }) {
    const condition = query.runId
      ? eq(agentRuns.id, query.runId)
      : query.appId && query.clientRequestId
        ? and(eq(agentRuns.appId, query.appId), eq(agentRuns.clientRequestId, query.clientRequestId))
        : null
    if (!condition) throw ApiException.badRequest('需要提供 runId，或同时提供 appId 与 clientRequestId')
    const [row] = await this.db.db
      .select({ run: agentRuns, ownerId: apps.ownerId })
      .from(agentRuns)
      .innerJoin(apps, eq(apps.id, agentRuns.appId))
      .where(condition)
      .limit(1)
    if (!row) throw ApiException.notFound('运行记录不存在')
    if (row.ownerId !== userId) throw ApiException.forbidden('无权查看该运行')
    return {
      runId: row.run.id,
      appId: row.run.appId,
      status: row.run.status,
      phase: row.run.phase,
      stepCount: row.run.stepCount,
      repairCount: row.run.repairCount,
      errorCode: row.run.errorCode,
      errorSummary: row.run.errorSummary,
      detailsStatus: row.run.detailsStatus,
      detailsError: row.run.detailsError,
      startedAt: row.run.startedAt?.toISOString() ?? null,
      deadlineAt: row.run.deadlineAt?.toISOString() ?? null,
      finishedAt: row.run.finishedAt?.toISOString() ?? null,
    }
  }

  async latestFinishedEvent(runId: string) {
    const [run] = await this.db.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    if (!run) return null
    return {
      status: run.status,
      errorCode: run.errorCode,
      errorSummary: run.errorSummary,
    }
  }

  async replayChunks(runId: string): Promise<AppUIMessageChunk[]> {
    const [assistant] = await this.db.db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.runId, runId), eq(messages.role, 'assistant')))
      .limit(1)
    return assistant?.content ? replayMessageChunks(assistant.content as AppUIMessage) : []
  }

  async markInterrupted(): Promise<number> {
    const activeRuns = await this.db.db
      .select()
      .from(agentRuns)
      .where(inArray(agentRuns.status, ['running', 'cancelling']))
    for (const run of activeRuns) {
      await this.sessionStore.ensureToolResults(
        run.conversationId,
        run.id,
        '运行因后端重启中断，工具结果未确认',
      )
      await this.db.db.transaction(async (tx) => {
        const [assistant] = await tx
          .select()
          .from(messages)
          .where(
            and(eq(messages.runId, run.id), eq(messages.role, 'assistant'), eq(messages.status, 'streaming')),
          )
          .limit(1)
        const stored = assistant?.content as AppUIMessage | undefined
        const interrupted = appendText(
          stored ?? assistantMessage(run.id),
          messageText(stored) ? '\n\n[运行因后端重启中断，未自动续跑]' : '运行因后端重启中断，未自动续跑。',
        )
        const finalContent = finishMessage(interrupted, run.id, 'failed')
        await tx
          .update(agentRuns)
          .set({
            status: 'failed',
            phase: 'finish',
            finishedAt: new Date(),
            errorCode: 'INTERRUPTED',
            errorSummary: '后端重启导致运行中断，未自动续跑',
            detailsStatus: 'incomplete',
            detailsError: '后端重启导致运行详情未能完整收尾',
          })
          .where(eq(agentRuns.id, run.id))
        await tx
          .update(messages)
          .set({
            status: 'failed',
            content: finalContent,
            updatedAt: new Date(),
          })
          .where(
            and(eq(messages.runId, run.id), eq(messages.role, 'assistant'), eq(messages.status, 'streaming')),
          )
      })
    }
    return activeRuns.length
  }

  async deleteAppData(appId: number) {
    const [conversation] = await this.db.db
      .select()
      .from(conversations)
      .where(eq(conversations.appId, appId))
      .limit(1)
    if (!conversation) return
    await this.db.db.transaction(async (tx) => {
      await tx.delete(messages).where(eq(messages.conversationId, conversation.id))
      await tx.delete(agentRuns).where(eq(agentRuns.appId, appId))
      await tx.delete(conversations).where(eq(conversations.id, conversation.id))
    })
  }

  async listRunIdsForApp(appId: number) {
    const rows = await this.db.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.appId, appId))
    return rows.map((r) => r.id)
  }
}

class DuplicateRunError extends Error {
  constructor(readonly run: RunRow) {
    super('duplicate run')
  }
}
