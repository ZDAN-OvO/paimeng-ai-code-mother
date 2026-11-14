import { Injectable, Logger } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppConfigService } from '../config/config.module'
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { ApiException } from '../common/api'
import { DbService } from '../db/db.module'
import { apps, conversations, agentRuns } from '../db/schema'
import { PreviewService } from '../preview/preview.service'
import { RuntimeService } from '../runtime/runtime.service'

export interface AppVO {
  id: number
  appName: string
  initPrompt: string | null
  codeGenType: 'static' | 'vue' | 'react' | null
  userId: number
  status: string
  createTime: string
  updateTime: string
  currentRun: {
    runId: string
    id: string
    status: string
    phase: string
    stepCount: number
    repairCount: number
    startedAt: string
    deadlineAt: string
  } | null
  preview: {
    status: 'stopped' | 'starting' | 'running' | 'failed' | 'unavailable'
    kind: 'static' | 'vue' | 'react' | null
    url: string | null
    lastError: string | null
  }
}

const SORT_FIELDS = {
  createTime: apps.createdAt,
  updateTime: apps.updatedAt,
  id: apps.id,
  appName: apps.appName,
} as const

@Injectable()
export class AppsService {
  private readonly logger = new Logger(AppsService.name)
  private retryTimers = new Map<number, NodeJS.Timeout>()
  private readonly deletions = new Map<number, Set<Promise<void>>>()
  private deletionStopped = false

  constructor(
    private readonly db: DbService,
    private readonly runtime: RuntimeService,
    private readonly preview: PreviewService,
    private readonly config: AppConfigService,
  ) {}

  async createApp(userId: number, initPrompt: string): Promise<{ id: number }> {
    const prompt = initPrompt.trim()
    const appName = Array.from(prompt).slice(0, 12).join('') || '未命名应用'
    const app = await this.db.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(apps)
        .values({ ownerId: userId, appName, initPrompt: prompt, status: 'active' })
        .returning({ id: apps.id })
      await tx.insert(conversations).values({ appId: created.id })
      return created
    })
    await this.runtime.ensureSourceDir(app.id)
    return { id: app.id }
  }

  async listMyApps(
    userId: number,
    current = 1,
    pageSize = 12,
    sortField = 'createTime',
    sortOrder = 'desc',
  ) {
    const page = Math.max(1, Math.floor(current) || 1)
    const size = Math.min(50, Math.max(1, Math.floor(pageSize) || 12))
    const column = SORT_FIELDS[sortField as keyof typeof SORT_FIELDS] ?? SORT_FIELDS.createTime
    const order = sortOrder === 'asc' ? asc(column) : desc(column)
    const where = and(eq(apps.ownerId, userId), eq(apps.status, 'active'))
    const [{ value: total }] = await this.db.db
      .select({ value: count() })
      .from(apps)
      .where(where)
    const rows = await this.db.db
      .select()
      .from(apps)
      .where(where)
      .orderBy(order, desc(apps.id))
      .limit(size)
      .offset((page - 1) * size)
    const records = await Promise.all(rows.map((row) => this.toVO(row, false)))
    return { records, total, current: page, pageSize: size }
  }

  async findOwnedApp(appId: number, userId: number) {
    const [app] = await this.db.db.select().from(apps).where(eq(apps.id, appId)).limit(1)
    if (!app) throw ApiException.notFound('应用不存在')
    if (app.ownerId !== userId) throw ApiException.forbidden('无权访问该应用')
    return app
  }

  async getAppVO(appId: number, userId: number): Promise<AppVO> {
    const app = await this.findOwnedApp(appId, userId)
    return this.toVO(app, true)
  }

  private async toVO(app: typeof apps.$inferSelect, withRuntime: boolean): Promise<AppVO> {
    const [run] = await this.db.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.appId, app.id), inArray(agentRuns.status, ['running', 'cancelling'])))
      .limit(1)
    let detected: 'static' | 'vue' | 'react' | null = null
    try {
      const info = await this.runtime.detectProject(app.id)
      if (info.hasPackageJson) detected = info.kind
      else if (existsSync(join(this.config.appSourceDir(app.id), 'index.html'))) detected = 'static'
    } catch {
      detected = null
    }
    const previewStatus = withRuntime
      ? await this.preview.getStatus(app.id)
      : { status: 'stopped' as const, kind: detected, url: null, lastError: null }
    return {
      id: app.id,
      appName: app.appName,
      initPrompt: app.initPrompt,
      codeGenType: detected,
      userId: app.ownerId,
      status: app.status,
      createTime: app.createdAt.toISOString(),
      updateTime: app.updatedAt.toISOString(),
      currentRun: run
        ? {
            runId: run.id,
            id: run.id,
            status: run.status,
            phase: run.phase,
            stepCount: run.stepCount,
            repairCount: run.repairCount,
            startedAt: run.startedAt.toISOString(),
            deadlineAt: run.deadlineAt.toISOString(),
          }
        : null,
      preview: previewStatus,
    }
  }

  async rename(appId: number, userId: number, appName: string) {
    const name = appName.trim()
    if (name.length < 1 || name.length > 50) throw ApiException.badRequest('应用名称需为 1-50 个字符')
    const app = await this.findOwnedApp(appId, userId)
    if (app.status !== 'active') throw ApiException.conflict('应用正在删除，无法改名')
    await this.db.db
      .update(apps)
      .set({ appName: name, updatedAt: new Date() })
      .where(and(eq(apps.id, appId), eq(apps.status, 'active')))
    return true
  }

  async requestDelete(appId: number, userId: number) {
    await this.db.db.transaction(async (tx) => {
      const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update').limit(1)
      if (!app) throw ApiException.notFound('应用不存在')
      if (app.ownerId !== userId) throw ApiException.forbidden('无权删除该应用')
      if (app.status === 'deleting') return
      const [active] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.appId, appId), inArray(agentRuns.status, ['running', 'cancelling'])))
        .limit(1)
      if (active) throw ApiException.conflict('应用仍有运行中的任务，请先停止后再删除')
      await tx
        .update(apps)
        .set({ status: 'deleting', deleteError: null, deleteNextRetryAt: null, updatedAt: new Date() })
        .where(eq(apps.id, appId))
    })
    this.preview.revokeApp(appId, 'deleted')
    this.backgroundDelete(appId)
    return true
  }

  private untrackDelete(appId: number, task: Promise<void>, tasks: Set<Promise<void>>) {
    tasks.delete(task)
    if (!tasks.size && this.deletions.get(appId) === tasks) this.deletions.delete(appId)
  }

  private runDelete(appId: number) {
    if (this.deletionStopped) return Promise.resolve()
    const task = this.performDelete(appId)
    const tasks = this.deletions.get(appId) ?? new Set<Promise<void>>()
    this.deletions.set(appId, tasks)
    tasks.add(task)
    void task.then(
      () => this.untrackDelete(appId, task, tasks),
      () => this.untrackDelete(appId, task, tasks),
    )
    return task
  }

  private backgroundDelete(appId: number) {
    void this.runDelete(appId).catch((err) => {
      this.logger.warn(
        `应用 ${appId} 删除任务异常: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  async waitForDeletions(appIds: number[]) {
    const tasks = appIds.flatMap((appId) => [...(this.deletions.get(appId) ?? [])])
    await Promise.allSettled(tasks)
  }

  stopDeletionRetries(appIds: number[]) {
    this.deletionStopped = true
    for (const appId of appIds) {
      const timer = this.retryTimers.get(appId)
      if (!timer) continue
      clearTimeout(timer)
      this.retryTimers.delete(appId)
    }
  }

  private async performDelete(appId: number) {
    try {
      await this.preview.stopForDelete(appId)
      await this.runtime.cleanupAppRuntime(appId)
      await this.db.db.transaction(async (tx) => {
        const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update').limit(1)
        if (!app || app.status !== 'deleting') return
        await tx.delete(apps).where(eq(apps.id, appId))
      })
      this.logger.log(`应用 ${appId} 已删除`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const [app] = await this.db.db.select().from(apps).where(eq(apps.id, appId)).limit(1)
      if (!app) return
      const attempts = app.deleteAttempts + 1
      const delay = attempts === 1 ? 5_000 : attempts === 2 ? 30_000 : attempts === 3 ? 120_000 : 600_000
      await this.db.db
        .update(apps)
        .set({
          deleteAttempts: attempts,
          deleteError: message.slice(0, 2000),
          deleteNextRetryAt: new Date(Date.now() + delay),
          updatedAt: new Date(),
        })
        .where(eq(apps.id, appId))
      this.logger.warn(`应用 ${appId} 删除失败（第 ${attempts} 次）：${message}`)
      this.scheduleRetry(appId, delay)
    }
  }

  private scheduleRetry(appId: number, delay: number) {
    if (this.deletionStopped) return
    const existing = this.retryTimers.get(appId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(appId)
      this.backgroundDelete(appId)
    }, delay)
    timer.unref()
    this.retryTimers.set(appId, timer)
  }

  async resumePendingDeletes() {
    const rows = await this.db.db
      .select({ id: apps.id, next: apps.deleteNextRetryAt })
      .from(apps)
      .where(eq(apps.status, 'deleting'))
    for (const row of rows) {
      const delay = row.next ? Math.max(0, row.next.getTime() - Date.now()) : 0
      if (delay === 0) this.backgroundDelete(row.id)
      else this.scheduleRetry(row.id, delay)
    }
    return rows.length
  }

  async markExecBlocked(appId: number, blocked: boolean) {
    await this.db.db.update(apps).set({ execBlocked: blocked }).where(eq(apps.id, appId))
  }

  async assertCanRun(appId: number, userId: number) {
    const app = await this.findOwnedApp(appId, userId)
    if (app.status !== 'active') throw ApiException.conflict('应用正在删除，无法执行任务')
    if (app.execBlocked) throw ApiException.conflict('应用存在未确认停止的任务容器，暂时无法执行')
    return app
  }

  async listStaleDeleting() {
    return this.db.db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.status, 'deleting'), isNull(apps.deleteNextRetryAt)))
  }

  async hasActiveRun(appId: number) {
    const [row] = await this.db.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.appId, appId), inArray(agentRuns.status, ['running', 'cancelling'])))
      .limit(1)
    return Boolean(row)
  }

  async countActiveAppsForUser(userId: number) {
    const [row] = await this.db.db
      .select({ value: sql<number>`count(distinct ${agentRuns.appId})` })
      .from(agentRuns)
      .innerJoin(apps, eq(apps.id, agentRuns.appId))
      .where(
        and(
          eq(apps.ownerId, userId),
          inArray(agentRuns.status, ['running', 'cancelling']),
          ne(apps.status, 'deleting'),
        ),
      )
    return Number(row?.value ?? 0)
  }
}
