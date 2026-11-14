import { Injectable, Logger } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, asc, count, desc, eq, gt, sql, sum } from 'drizzle-orm'
import { ApiException } from '../common/api'
import { AppConfigService } from '../config/config.module'
import { Database, DbService } from '../db/db.module'
import {
  agentRuns,
  apps,
  contentBlobs,
  runActivities,
  runFiles,
  runPlans,
  runValidationLogs,
} from '../db/schema'

const execFileAsync = promisify(execFile)

const SKIP_ROOTS = new Set(['node_modules', 'dist', '.git', '.vite', '.cache', 'coverage', '.nuxt', '.next'])

const SKIP_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
])

const MAX_PATHS = 5000
const MAX_PATH_BYTES = 1024

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanStep {
  id: string
  title: string
  status: PlanStepStatus
}

interface FileFact {
  path: string
  size: number
  hash: string
  content: Buffer | null
  blobId?: string
}

export interface ChangeSummary {
  filesChanged: number
  additions: number | null
  deletions: number | null
  complete: boolean
  partial: boolean
}

type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

@Injectable()
export class RunDetailsService {
  private readonly logger = new Logger(RunDetailsService.name)

  constructor(
    private readonly config: AppConfigService,
    private readonly db: DbService,
  ) {}

  private sourceRoot(appId: number) {
    return this.config.appSourceDir(appId)
  }

  private shouldSkip(name: string, relative: string): boolean {
    if (SKIP_ROOTS.has(name)) return true
    if (SKIP_FILES.has(name)) return true
    if (name.startsWith('.paimeng-')) return true
    if (name.endsWith('.tmp')) return true
    if (Buffer.byteLength(relative, 'utf8') > MAX_PATH_BYTES) return true
    return false
  }

  private async scan(appId: number): Promise<Map<string, FileFact>> {
    const root = this.sourceRoot(appId)
    const result = new Map<string, FileFact>()
    if (!existsSync(root)) return result
    const walk = async (dir: string, prefix: string) => {
      const entries = await readdir(dir, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (result.size >= MAX_PATHS) throw new Error('项目文件数量超过运行详情上限（5000）')
        if (entry.isSymbolicLink()) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (this.shouldSkip(entry.name, relative)) continue
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute, relative)
          continue
        }
        if (!entry.isFile()) continue
        const info = await lstat(absolute)
        if (info.size > this.config.maxFileBytes) {
          const raw = await readFile(absolute)
          result.set(relative, {
            path: relative,
            size: info.size,
            hash: createHash('sha256').update(raw).digest('hex'),
            content: null,
          })
          continue
        }
        const raw = await readFile(absolute)
        result.set(relative, {
          path: relative,
          size: raw.length,
          hash: createHash('sha256').update(raw).digest('hex'),
          content: raw,
        })
      }
    }
    await walk(root, '')
    const manifestBytes = [...result.keys()].reduce(
      (total, path) => total + Buffer.byteLength(path, 'utf8') + 128,
      0,
    )
    if (manifestBytes > this.config.runDetailManifestMaxBytes) {
      throw new Error('运行详情清单超过存储上限')
    }
    return result
  }

  private async putBlob(exec: Executor, appId: number, content: Buffer): Promise<string> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const [existing] = await exec
      .select({ id: contentBlobs.id })
      .from(contentBlobs)
      .where(and(eq(contentBlobs.appId, appId), eq(contentBlobs.sha256, sha256)))
      .limit(1)
    if (existing) return existing.id
    const [inserted] = await exec
      .insert(contentBlobs)
      .values({ appId, sha256, size: content.length, content })
      .onConflictDoNothing()
      .returning({ id: contentBlobs.id })
    if (inserted) return inserted.id
    const [again] = await exec
      .select({ id: contentBlobs.id })
      .from(contentBlobs)
      .where(and(eq(contentBlobs.appId, appId), eq(contentBlobs.sha256, sha256)))
      .limit(1)
    if (!again) throw new Error('文件内容持久化失败')
    return again.id
  }

  async ensureBaseline(runId: string, appId: number): Promise<void> {
    const [existing] = await this.db.db
      .select({ value: count() })
      .from(runFiles)
      .where(eq(runFiles.runId, runId))
    if (Number(existing?.value ?? 0) > 0) return
    const facts = await this.scan(appId)
    await this.db.db.transaction(async (tx) => {
      let manifestBytes = 0
      for (const fact of facts.values()) {
        manifestBytes += Buffer.byteLength(fact.path, 'utf8') + 128
        if (manifestBytes > this.config.runDetailManifestMaxBytes) {
          throw new Error('运行详情清单超过存储上限')
        }
        const blobId = fact.content ? await this.putBlob(tx, appId, fact.content) : undefined
        await tx.insert(runFiles).values({
          runId,
          appId,
          path: fact.path,
          baseHash: fact.hash,
          baseBlobId: blobId,
          status: 'pending',
          diffStatus: fact.content ? 'pending' : 'too_large',
        })
      }
    })
  }

  async assertQuota(appId: number, exec: Executor = this.db.db): Promise<void> {
    const usage = await this.usageBytes(exec, appId)
    if (usage + this.config.runDetailReserveBytes > this.config.runDetailQuotaBytes) {
      throw ApiException.conflict('应用的历史详情空间不足，请删除应用或提高详情配额后再运行')
    }
  }

  private async usageBytes(exec: Executor, appId: number): Promise<number> {
    const [blobUsage] = await exec
      .select({ value: sum(contentBlobs.size) })
      .from(contentBlobs)
      .where(eq(contentBlobs.appId, appId))
    const [fileCount] = await exec.select({ value: count() }).from(runFiles).where(eq(runFiles.appId, appId))
    const [activityCount] = await exec
      .select({ value: count() })
      .from(runActivities)
      .where(eq(runActivities.appId, appId))
    const [planCount] = await exec.select({ value: count() }).from(runPlans).where(eq(runPlans.appId, appId))
    return (
      Number(blobUsage?.value ?? 0) +
      Number(fileCount?.value ?? 0) * 256 +
      Number(activityCount?.value ?? 0) * 128 +
      Number(planCount?.value ?? 0) * 1024
    )
  }

  async refreshUsage(appId: number): Promise<void> {
    const usage = await this.usageBytes(this.db.db, appId)
    await this.db.db.update(apps).set({ historyUsedBytes: usage }).where(eq(apps.id, appId))
  }

  async finalizeRun(runId: string, appId: number): Promise<ChangeSummary> {
    const startedAt = Date.now()
    const checkDeadline = () => {
      if (Date.now() - startedAt > this.config.runDetailFinalizeTimeoutMs) {
        throw new Error('运行详情收尾超过 30 秒')
      }
    }
    const baselineRows = await this.db.db.select().from(runFiles).where(eq(runFiles.runId, runId))
    const baseline = new Map(baselineRows.map((row) => [row.path, row]))
    const finalFacts = await this.scan(appId)
    const paths = new Set([...baseline.keys(), ...finalFacts.keys()])
    let filesChanged = 0
    let additions: number | null = 0
    let deletions: number | null = 0
    let partial = false

    await this.db.db.transaction(async (tx) => {
      for (const path of [...paths].sort()) {
        checkDeadline()
        const baseRow = baseline.get(path)
        const finalFact = finalFacts.get(path)
        const unchanged = Boolean(baseRow && finalFact && baseRow.baseHash === finalFact.hash)
        const status = unchanged
          ? 'unchanged'
          : baseRow && finalFact
            ? 'modified'
            : finalFact
              ? 'added'
              : 'deleted'
        if (status === 'unchanged') {
          if (baseRow) {
            await tx
              .update(runFiles)
              .set({
                finalHash: finalFact?.hash ?? null,
                status,
                diffStatus: baseRow.diffStatus,
                updatedAt: new Date(),
              })
              .where(eq(runFiles.id, baseRow.id))
          }
          continue
        }
        filesChanged += 1
        let finalBlobId: string | undefined
        if (finalFact?.content) finalBlobId = await this.putBlob(tx, appId, finalFact.content)
        let diff: string | null = null
        let diffStatus: 'ready' | 'binary' | 'too_large' | 'error'
        let fileAdditions: number | null = 0
        let fileDeletions: number | null = 0
        try {
          const diffResult = await this.computeDiff(path, baseRow, finalFact)
          diff = diffResult.diff
          diffStatus = diffResult.status
          fileAdditions = diffResult.additions
          fileDeletions = diffResult.deletions
          if (diffStatus !== 'ready' && diffStatus !== 'binary') partial = true
          if (diffStatus === 'binary') {
            fileAdditions = null
            fileDeletions = null
            additions = null
            deletions = null
          } else if (fileAdditions === null || fileDeletions === null) {
            additions = null
            deletions = null
          } else if (additions !== null && deletions !== null) {
            additions += fileAdditions
            deletions += fileDeletions
          }
        } catch (err) {
          this.logger.warn(`计算 ${path} 的 diff 失败: ${err instanceof Error ? err.message : String(err)}`)
          diffStatus = 'error'
          partial = true
          additions = null
          deletions = null
        }
        const values = {
          appId,
          runId,
          path,
          baseHash: baseRow?.baseHash ?? null,
          finalHash: finalFact?.hash ?? null,
          baseBlobId: baseRow?.baseBlobId ?? null,
          finalBlobId: finalBlobId ?? null,
          status,
          linesAdded: fileAdditions,
          linesDeleted: fileDeletions,
          diffStatus,
          diff,
          updatedAt: new Date(),
        }
        if (baseRow) {
          await tx.update(runFiles).set(values).where(eq(runFiles.id, baseRow.id))
        } else {
          await tx.insert(runFiles).values(values)
        }
      }
    })
    await this.refreshUsage(appId)
    return {
      filesChanged,
      additions,
      deletions,
      complete: !partial,
      partial,
    }
  }

  private async readBlob(blobId: string | null | undefined): Promise<Buffer> {
    if (!blobId) return Buffer.alloc(0)
    const [row] = await this.db.db
      .select({ content: contentBlobs.content })
      .from(contentBlobs)
      .where(eq(contentBlobs.id, blobId))
      .limit(1)
    return row?.content ?? Buffer.alloc(0)
  }

  private async computeDiff(
    path: string,
    baseRow: { baseBlobId: string | null; baseHash: string | null } | undefined,
    finalFact: FileFact | undefined,
  ): Promise<{
    diff: string | null
    status: 'ready' | 'binary' | 'too_large'
    additions: number | null
    deletions: number | null
  }> {
    if (!baseRow?.baseBlobId && !finalFact?.content) {
      return { diff: '', status: 'ready', additions: 0, deletions: 0 }
    }
    if (baseRow?.baseHash && !baseRow.baseBlobId) {
      return { diff: null, status: 'too_large', additions: null, deletions: null }
    }
    const before = await this.readBlob(baseRow?.baseBlobId)
    const after = finalFact?.content ?? Buffer.alloc(0)
    if (before.includes(0) || after.includes(0)) {
      return { diff: null, status: 'binary', additions: null, deletions: null }
    }
    if (before.length > this.config.maxFileBytes || after.length > this.config.maxFileBytes) {
      return { diff: null, status: 'too_large', additions: null, deletions: null }
    }
    const dir = await mkdtemp(join(tmpdir(), 'paimeng-diff-'))
    const beforePath = join(dir, 'before')
    const afterPath = join(dir, 'after')
    try {
      await writeFile(beforePath, before)
      await writeFile(afterPath, after)
      const args = [
        'diff',
        '--no-index',
        '--text',
        '--unified=3',
        '--no-color',
        '--no-ext-diff',
        '--',
        beforePath,
        afterPath,
      ]
      let stdout = ''
      try {
        const result = await execFileAsync('git', args, {
          timeout: 2000,
          maxBuffer: this.config.runDetailDiffMaxBytes * 4,
        })
        stdout = result.stdout
      } catch (err) {
        const candidate = err as { code?: number; stdout?: string; killed?: boolean }
        if (candidate.code !== 1) {
          if (candidate.killed) return { diff: null, status: 'too_large', additions: null, deletions: null }
          throw err
        }
        stdout = candidate.stdout ?? ''
      }
      const normalized = stdout.replaceAll(beforePath, `a/${path}`).replaceAll(afterPath, `b/${path}`)
      const hunkStart = normalized.indexOf('@@')
      const diff = hunkStart >= 0 ? normalized.slice(hunkStart) : normalized
      let additions = 0
      let deletions = 0
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
        else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
      }
      const truncated = Buffer.byteLength(diff, 'utf8') > this.config.runDetailDiffMaxBytes
      return {
        diff: truncated ? diff.slice(0, this.config.runDetailDiffMaxBytes) : diff,
        status: truncated ? 'too_large' : 'ready',
        additions: truncated ? null : additions,
        deletions: truncated ? null : deletions,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async savePlan(
    runId: string,
    appId: number,
    steps: PlanStep[],
  ): Promise<{ revision: number; steps: PlanStep[] }> {
    if (steps.length < 1 || steps.length > 8) throw new Error('计划需要 1-8 个步骤')
    const ids = new Set<string>()
    let inProgress = 0
    for (const step of steps) {
      if (!step.id || step.id.length > 64) throw new Error('计划步骤 ID 无效')
      if (ids.has(step.id)) throw new Error('计划步骤 ID 不能重复')
      ids.add(step.id)
      if (!step.title || step.title.length > 200) throw new Error('计划步骤标题无效')
      if (!['pending', 'in_progress', 'completed'].includes(step.status)) throw new Error('计划步骤状态无效')
      if (step.status === 'in_progress') inProgress += 1
    }
    if (inProgress > 1) throw new Error('同时只能有一个计划步骤执行中')
    const [updated] = await this.db.db
      .insert(runPlans)
      .values({ runId, appId, revision: 1, steps })
      .onConflictDoUpdate({
        target: runPlans.runId,
        set: { steps, revision: sql`${runPlans.revision} + 1`, updatedAt: new Date() },
      })
      .returning({ revision: runPlans.revision })
    if (!updated) throw new Error('计划保存失败')
    return { revision: updated.revision, steps }
  }

  async hasPlan(runId: string): Promise<boolean> {
    const [row] = await this.db.db
      .select({ id: runPlans.id })
      .from(runPlans)
      .where(eq(runPlans.runId, runId))
      .limit(1)
    return Boolean(row)
  }

  async getPlan(runId: string) {
    const [row] = await this.db.db.select().from(runPlans).where(eq(runPlans.runId, runId)).limit(1)
    if (!row) return null
    return {
      revision: row.revision,
      steps: row.steps as PlanStep[],
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  async recordActivity(runId: string, appId: number, type: string, payload: Record<string, unknown>) {
    const [row] = await this.db.db
      .select({
        value: count(),
        bytes: sql<number>`coalesce(sum(length(${runActivities.payload}::text)), 0)`,
      })
      .from(runActivities)
      .where(eq(runActivities.runId, runId))
    const currentBytes = Number(row?.bytes ?? 0)
    const encoded = JSON.stringify(payload)
    if (Number(row?.value ?? 0) >= 2000) return null
    if (currentBytes + Buffer.byteLength(encoded, 'utf8') > this.config.runDetailActivityMaxBytes) return null
    const [inserted] = await this.db.db
      .insert(runActivities)
      .values({ runId, appId, type, payload })
      .returning({ id: runActivities.id, createdAt: runActivities.createdAt })
    return inserted ?? null
  }

  async listActivities(userId: number, runId: string, afterId?: number, limit = 200) {
    await this.assertRunOwner(userId, runId)
    const rows = await this.db.db
      .select()
      .from(runActivities)
      .where(
        afterId
          ? and(eq(runActivities.runId, runId), gt(runActivities.id, afterId))
          : eq(runActivities.runId, runId),
      )
      .orderBy(asc(runActivities.id))
      .limit(Math.min(500, Math.max(1, limit)))
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload as Record<string, unknown>,
      at: row.createdAt.toISOString(),
    }))
  }

  async recordValidationLog(params: {
    runId: string
    appId: number
    attempt: number
    checkName: string
    status: string
    summary?: string | null
    logs?: string | null
  }) {
    const logs = params.logs ? params.logs.slice(-64 * 1024) : null
    const truncated = Boolean(params.logs && Buffer.byteLength(params.logs, 'utf8') > 64 * 1024)
    await this.db.db
      .insert(runValidationLogs)
      .values({
        runId: params.runId,
        appId: params.appId,
        attempt: params.attempt,
        checkName: params.checkName,
        status: params.status,
        summary: params.summary ?? null,
        logs,
        truncated,
      })
      .onConflictDoUpdate({
        target: [runValidationLogs.runId, runValidationLogs.attempt, runValidationLogs.checkName],
        set: { status: params.status, summary: params.summary ?? null, logs, truncated },
      })
  }

  async getValidationLog(userId: number, runId: string, attempt: number, checkName: string) {
    await this.assertRunOwner(userId, runId)
    const [row] = await this.db.db
      .select()
      .from(runValidationLogs)
      .where(
        and(
          eq(runValidationLogs.runId, runId),
          eq(runValidationLogs.attempt, attempt),
          eq(runValidationLogs.checkName, checkName),
        ),
      )
      .limit(1)
    if (!row) throw ApiException.notFound('验证日志不存在')
    return {
      attempt: row.attempt,
      check: row.checkName,
      status: row.status,
      summary: row.summary,
      logs: row.logs,
      truncated: row.truncated,
    }
  }

  async getDetails(userId: number, runId: string) {
    const [row] = await this.db.db
      .select({ run: agentRuns, ownerId: apps.ownerId })
      .from(agentRuns)
      .innerJoin(apps, eq(apps.id, agentRuns.appId))
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (!row) throw ApiException.notFound('运行记录不存在')
    if (row.ownerId !== userId) throw ApiException.forbidden('无权查看该运行')
    const plan = await this.getPlan(runId)
    const validations = await this.db.db
      .select({
        attempt: runValidationLogs.attempt,
        check: runValidationLogs.checkName,
        status: runValidationLogs.status,
        summary: runValidationLogs.summary,
        truncated: runValidationLogs.truncated,
      })
      .from(runValidationLogs)
      .where(eq(runValidationLogs.runId, runId))
      .orderBy(asc(runValidationLogs.attempt), asc(runValidationLogs.id))
    const [summary] = await this.db.db
      .select({
        filesChanged: sql<number>`count(*) filter (where ${runFiles.status} <> 'unchanged' and ${runFiles.status} <> 'pending')`,
        additions: sql<
          number | null
        >`sum(${runFiles.linesAdded}) filter (where ${runFiles.status} <> 'unchanged')`,
        deletions: sql<
          number | null
        >`sum(${runFiles.linesDeleted}) filter (where ${runFiles.status} <> 'unchanged')`,
        partial: sql<boolean>`bool_or(${runFiles.diffStatus} in ('too_large','error'))`,
      })
      .from(runFiles)
      .where(eq(runFiles.runId, runId))
    const [lastActivity] = await this.db.db
      .select({ id: runActivities.id })
      .from(runActivities)
      .where(eq(runActivities.runId, runId))
      .orderBy(desc(runActivities.id))
      .limit(1)
    return {
      runId,
      appId: row.run.appId,
      status: row.run.status,
      phase: row.run.phase,
      stepCount: row.run.stepCount,
      repairCount: row.run.repairCount,
      startedAt: row.run.startedAt?.toISOString() ?? null,
      deadlineAt: row.run.deadlineAt?.toISOString() ?? null,
      finishedAt: row.run.finishedAt?.toISOString() ?? null,
      errorCode: row.run.errorCode,
      errorSummary: row.run.errorSummary,
      detailsStatus: row.run.detailsStatus,
      detailsError: row.run.detailsError,
      plan,
      validations,
      activityWatermark: lastActivity?.id ?? 0,
      changes: {
        filesChanged: Number(summary?.filesChanged ?? 0),
        additions:
          summary?.additions === null || summary?.additions === undefined ? null : Number(summary.additions),
        deletions:
          summary?.deletions === null || summary?.deletions === undefined ? null : Number(summary.deletions),
        complete: !summary?.partial && row.run.detailsStatus === 'ready',
        partial: Boolean(summary?.partial),
      },
    }
  }

  async listChanges(userId: number, runId: string, cursor?: number, limit = 100) {
    await this.assertRunOwner(userId, runId)
    const size = Math.min(200, Math.max(1, limit))
    const rows = await this.db.db
      .select({
        id: runFiles.id,
        path: runFiles.path,
        status: runFiles.status,
        additions: runFiles.linesAdded,
        deletions: runFiles.linesDeleted,
        diffStatus: runFiles.diffStatus,
      })
      .from(runFiles)
      .where(
        cursor
          ? and(eq(runFiles.runId, runId), gt(runFiles.id, cursor), sql`${runFiles.status} <> 'unchanged'`)
          : and(eq(runFiles.runId, runId), sql`${runFiles.status} <> 'unchanged'`),
      )
      .orderBy(asc(runFiles.id))
      .limit(size + 1)
    const records = rows.slice(0, size).map((row) => ({
      id: row.id,
      path: row.path,
      status: row.status,
      additions: row.additions,
      deletions: row.deletions,
      diffStatus: row.diffStatus,
    }))
    return {
      records,
      nextCursor: rows.length > size ? String(rows[size].id) : null,
    }
  }

  async getChangeDiff(userId: number, runId: string, fileId: number, cursor = 0, limit = 200) {
    await this.assertRunOwner(userId, runId)
    const [row] = await this.db.db
      .select()
      .from(runFiles)
      .where(and(eq(runFiles.runId, runId), eq(runFiles.id, fileId)))
      .limit(1)
    if (!row) throw ApiException.notFound('文件变更不存在')
    if (!row.diff) {
      return {
        fileId,
        path: row.path,
        status: row.diffStatus,
        lines: [],
        nextCursor: null,
        complete: row.diffStatus === 'ready',
      }
    }
    const lines = row.diff.split('\n')
    const start = Math.max(0, cursor)
    const page = lines.slice(start, start + Math.min(500, Math.max(1, limit)))
    return {
      fileId,
      path: row.path,
      status: row.diffStatus,
      lines: page,
      nextCursor: start + page.length < lines.length ? String(start + page.length) : null,
      complete: true,
    }
  }

  private async assertRunOwner(userId: number, runId: string) {
    const [row] = await this.db.db
      .select({ ownerId: apps.ownerId })
      .from(agentRuns)
      .innerJoin(apps, eq(apps.id, agentRuns.appId))
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (!row) throw ApiException.notFound('运行记录不存在')
    if (row.ownerId !== userId) throw ApiException.forbidden('无权查看该运行')
  }

  async markInterrupted(runIds: string[]) {
    for (const runId of runIds) {
      await this.db.db
        .update(agentRuns)
        .set({
          detailsStatus: 'incomplete',
          detailsError: '运行因后端重启中断，未生成完整变更详情',
        })
        .where(eq(agentRuns.id, runId))
    }
  }
}
