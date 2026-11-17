import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { stat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Test } from '@nestjs/testing'
import { eq } from 'drizzle-orm'
import { AppConfigService } from '../../dist/config/config.module.js'
import { DbService } from '../../dist/db/db.module.js'
import { RedisService } from '../../dist/redis/redis.module.js'
import { AppsService } from '../../dist/apps/apps.service.js'
import { PreviewService } from '../../dist/preview/preview.service.js'
import { AgentService } from '../../dist/agent/agent.service.js'
import { SessionStoreService } from '../../dist/agent/session-store.service.js'
import { RuntimeService } from '../../dist/runtime/runtime.service.js'
import { AppMutexService } from '../../dist/runtime/app-mutex.service.js'
import { RunDetailsService } from '../../dist/runs/run-details.service.js'
import { RunsService } from '../../dist/runs/runs.service.js'
import { MessageQueueStore } from '../../dist/runs/message-queue.store.js'
import { apps, conversations, users, agentRuns, messages } from '../../dist/db/schema.js'
import { assistantMessage, userMessage } from '../../dist/conversations/types.js'
import { isolatedConnections } from './isolated-env.mjs'

export const TEST_TIMEOUT = 30_000

export function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export async function bounded(promise, label, timeout = 5000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Observe a database/event condition; do not assume concurrency from elapsed time.
export async function until(probe, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  do {
    const value = await probe()
    if (value) return value
    await setImmediate()
  } while (Date.now() < deadline)
  assert.fail(`Condition not observed: ${label}`)
}

export async function waitForBlocked(pool, blockerPid, expected = 1) {
  return until(async () => {
    const { rows } = await pool.query(
      'select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))',
      [blockerPid],
    )
    return rows.length >= expected && rows
  }, 'PostgreSQL reports the competing statements blocked')
}

export const outcome = (status = 'completed', text = 'integration result') => ({
  status,
  text,
  stepCount: 1,
  repairCount: 0,
})

export async function withHarness(fn) {
  const connections = isolatedConnections()
  const workDir = process.env.CI_TEST_WORK_DIR
  assert.ok(
    workDir && isAbsolute(workDir),
    'CI_TEST_WORK_DIR must be an absolute private temporary directory',
  )
  assert.equal(await realpath(workDir), resolve(workDir), 'CI_TEST_WORK_DIR must not contain symlinks')
  const info = await stat(workDir)
  assert.ok(info.isDirectory() && (info.mode & 0o077) === 0, 'CI_TEST_WORK_DIR must be private (0700)')
  const config = {
    ...connections,
    maxRunsPerUser: 2,
    runMaxDurationMs: 60_000,
    appRateLimitPerMinute: 100,
    runDetailActivityMaxBytes: 1024 * 1024,
    runDetailManifestMaxBytes: 1024 * 1024,
    runDetailReserveBytes: 1024,
    runDetailQuotaBytes: 16 * 1024 * 1024,
    runDetailFinalizeTimeoutMs: 5000,
    maxFileBytes: 1024 * 1024,
    appSourceDir: (appId) => join(workDir, 'sources', String(appId)),
  }
  const executions = new Map()
  const agent = {
    async execute(params) {
      const gate = deferred()
      executions.set(params.runId, { gate, params })
      // Explicitly released by the test/cleanup, including on cancellation.
      return gate.promise
    },
  }
  const stopped = []
  const module = await Test.createTestingModule({
    providers: [
      { provide: AppConfigService, useValue: config },
      DbService,
      RedisService,
      AppsService,
      SessionStoreService,
      RunDetailsService,
      AppMutexService,
      MessageQueueStore,
      RunsService,
      { provide: 'peerRuns', useClass: RunsService },
      { provide: AgentService, useValue: agent },
      {
        provide: RuntimeService,
        useValue: {
          stopTask: async (appId) => {
            stopped.push(appId)
          },
          isTaskRunning: async () => false,
        },
      },
      { provide: PreviewService, useValue: {} },
    ],
  }).compile()
  const db = module.get(DbService)
  const redis = module.get(RedisService)
  const queue = module.get(MessageQueueStore)
  const runs = module.get(RunsService)
  const peerRuns = module.get('peerRuns')
  const ownedUsers = []
  const ownedApps = []
  const context = {
    db,
    redis,
    queue,
    runs,
    peerRuns,
    config,
    stopped,
    executions,
    sessions: module.get(SessionStoreService),
    async fixture(ownerId) {
      if (!ownerId) {
        const [user] = await db.db
          .insert(users)
          .values({
            userAccount: `ci_${randomUUID()}`,
            userPassword: 'unused-integration-password',
          })
          .returning()
        ownedUsers.push(user.id)
        ownerId = user.id
      }
      assert.ok(ownedUsers.includes(ownerId), 'Fixture owner must belong to this harness')
      const [app] = await db.db
        .insert(apps)
        .values({
          ownerId,
          appName: 'integration',
          initPrompt: 'integration fixture',
        })
        .returning()
      const [conversation] = await db.db.insert(conversations).values({ appId: app.id }).returning()
      // Never adopt/clear a pre-existing Redis key or registry member.
      assert.equal(await redis.client.exists(`chat:queue:app:${app.id}`), 0, 'Queue key already exists')
      assert.equal(
        Number(await redis.client.sIsMember('chat:queue:apps', String(app.id))),
        0,
        'Queue member already exists',
      )
      assert.equal(await redis.client.exists(`rate:app:${app.id}`), 0, 'Rate-limit key already exists')
      ownedApps.push(app.id)
      return { userId: ownerId, appId: app.id, conversationId: conversation.id }
    },
    async seedRun(fixture, status = 'running', requestId = randomUUID()) {
      const [run] = await db.db
        .insert(agentRuns)
        .values({
          appId: fixture.appId,
          conversationId: fixture.conversationId,
          clientRequestId: requestId,
          status,
          deadlineAt: new Date(Date.now() + 60_000),
        })
        .returning()
      await db.db.insert(messages).values([
        {
          conversationId: fixture.conversationId,
          runId: run.id,
          role: 'user',
          status: 'completed',
          content: userMessage(run.id, 'seed'),
        },
        {
          conversationId: fixture.conversationId,
          runId: run.id,
          role: 'assistant',
          status: 'streaming',
          content: assistantMessage(run.id),
        },
      ])
      await queue.openRun(fixture.appId, run.id)
      return run
    },
    async started(runId) {
      return until(() => executions.get(runId), 'Agent entered its controlled wait')
    },
    async finish(runId, result = outcome()) {
      const execution = await context.started(runId)
      const stream = runs.getStream(runId)
      assert.ok(stream, 'Started run has a stream')
      const done = new Promise((resolve) =>
        stream.subscribe((chunk) => {
          if (chunk === null) resolve()
        }),
      )
      execution.gate.resolve(result)
      await bounded(done, 'Run finalized', 10_000)
    },
  }
  try {
    await bounded(redis.ensureConnected(), 'Redis connection')
    await db.ping()
    return await fn(context)
  } finally {
    try {
      // Stop dispatch first, then settle every controlled execution before deleting rows.
      runs.onModuleDestroy()
      peerRuns.onModuleDestroy()
      await until(() => runs.dispatching.size === 0, 'Queue dispatch drained')
      await Promise.all([...executions.keys()].map((id) => context.finish(id, outcome('cancelled'))))
      if (redis.client.isReady) {
        for (const appId of ownedApps) {
          await queue.clear(appId)
          await redis.client.del(`rate:app:${appId}`)
        }
      }
      for (const id of ownedUsers) await db.db.delete(users).where(eq(users.id, id))
    } finally {
      try {
        await bounded(module.close(), 'Nest providers closed')
      } finally {
        if (redis.client.isOpen) redis.client.destroy()
      }
    }
  }
}
