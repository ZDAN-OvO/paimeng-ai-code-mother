import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { and, inArray } from 'drizzle-orm'
import { AppsService } from '../src/apps/apps.service'
import { SessionService } from '../src/auth/session.service'
import { AppConfigService } from '../src/config/config.module'
import { DbService } from '../src/db/db.module'
import { agentRuns, apps, users } from '../src/db/schema'
import { PreviewService } from '../src/preview/preview.service'
import { RedisService } from '../src/redis/redis.module'
import { DockerService } from '../src/runtime/docker.service'
import { RegistryRelayService } from '../src/runtime/registry-relay.service'
import { RuntimeService } from '../src/runtime/runtime.service'
import { INSTANCE_LOCK_KEY, MAINTENANCE_LOCK_KEY } from '../src/startup/instance-lock.service'

const execute = process.argv.includes('--execute')
const manifestPath = process.argv[process.argv.indexOf('--manifest') + 1]
const timeoutMs = 10 * 60_000

for (const path of ['.env', '../.env', 'paimeng-ai-code-mother-backend/.env']) {
  if (existsSync(path)) {
    process.loadEnvFile(path)
    break
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  if (!process.argv.includes('--manifest') || !manifestPath) {
    throw new Error('需要提供 --manifest <path>，用于固定预览与执行的应用清单')
  }
  const config = new AppConfigService()
  config.onModuleInit()
  const db = new DbService(config)
  const redis = new RedisService(config)
  const docker = new DockerService(config)
  const relay = new RegistryRelayService(config, docker)
  const runtime = new RuntimeService(config, docker, relay)
  const sessions = new SessionService(config, redis)
  const preview = new PreviewService(config, db, redis, docker, runtime, sessions)
  let maintenanceId: string | null = null

  try {
    await redis.onModuleInit()
    const client = await redis.ensureConnected()
    if (await client.get(INSTANCE_LOCK_KEY)) {
      throw new Error('后端仍在运行，请先停止后端再执行维护清理')
    }
    maintenanceId = randomUUID()
    const locked = await client.set(MAINTENANCE_LOCK_KEY, maintenanceId, {
      condition: 'NX',
      expiration: { type: 'PX', value: timeoutMs + 60_000 },
    })
    if (locked !== 'OK') throw new Error('另一个维护操作正在运行')

    await runtime.onModuleInit()
    const appsService = new AppsService(db, runtime, preview, config)
    const [allApps, userRows] = await Promise.all([
      db.db.select({ id: apps.id, ownerId: apps.ownerId, name: apps.appName }).from(apps).orderBy(apps.id),
      db.db.select({ id: users.id }).from(users),
    ])
    const snapshot = execute ? JSON.parse(readFileSync(manifestPath, 'utf8')).apps : allApps

    console.log(`待清理应用：${snapshot.length} 个；用户账号：${userRows.length} 个`)
    for (const app of snapshot) console.log(`  #${app.id} ${app.name}`)
    if (!execute) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          { createdAt: new Date().toISOString(), userCount: userRows.length, apps: snapshot },
          null,
          2,
        ),
      )
      console.log(`已写入固定清单：${manifestPath}\n使用 --execute --manifest ${manifestPath} 执行清理。`)
      return
    }
    if (!snapshot.length) {
      console.log('没有需要清理的应用。')
      return
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.userCount !== userRows.length) {
      throw new Error(`账号数量与清单不一致：清单 ${manifest.userCount}，当前 ${userRows.length}`)
    }
    const snapshotIds = new Set(snapshot.map((app: { id: number }) => app.id))
    const currentApps = await db.db
      .select({ id: apps.id, ownerId: apps.ownerId })
      .from(apps)
      .where(inArray(apps.id, [...snapshotIds]))
    for (const app of snapshot) {
      const current = currentApps.find((row) => row.id === app.id)
      if (current && current.ownerId !== app.ownerId) {
        throw new Error(`应用 ${app.id} 的所有者与清单不一致`)
      }
    }

    await db.db
      .update(agentRuns)
      .set({
        status: 'failed',
        phase: 'finish',
        errorCode: 'LEGACY_PURGE',
        errorSummary: '应用在消息协议切换时被清理',
        finishedAt: new Date(),
      })
      .where(
        and(inArray(agentRuns.status, ['running', 'cancelling']), inArray(agentRuns.appId, [...snapshotIds])),
      )

    for (const app of snapshot) {
      const current = currentApps.find((row) => row.id === app.id)
      if (!current) continue
      await appsService.requestDelete(app.id, app.ownerId)
    }

    const deadline = Date.now() + timeoutMs
    let remaining: number[] = []
    while (Date.now() < deadline) {
      const rows = await db.db.select({ id: apps.id }).from(apps)
      remaining = rows.map((row) => row.id).filter((id) => snapshotIds.has(id))
      if (!remaining.length) break
      await sleep(1000)
    }
    if (remaining.length) throw new Error(`以下应用未在截止时间内删除：${remaining.join(', ')}`)

    const [remainingUsers, containers] = await Promise.all([
      db.db.select({ id: users.id }).from(users),
      runtime.remainingProjectAppIds(),
    ])
    if (remainingUsers.length !== userRows.length) {
      throw new Error(`用户账号数量发生变化：清理前 ${userRows.length}，清理后 ${remainingUsers.length}`)
    }
    const leaked = containers.filter((id) => snapshotIds.has(id))
    if (leaked.length) throw new Error(`仍有旧应用容器：${leaked.join(', ')}`)

    const paths = snapshot.flatMap((app) => [
      config.appSourceDir(app.id),
      config.appDepsDir(app.id),
      config.appBuildDir(app.id),
      join(config.taskLogRoot, String(app.id)),
    ])
    const leftovers = paths.filter((path) => existsSync(path))
    if (leftovers.length) throw new Error(`以下运行目录仍存在：\n${leftovers.join('\n')}`)

    console.log(`清理完成：${snapshot.length} 个应用，账号保留 ${remainingUsers.length} 个。`)
  } finally {
    if (maintenanceId) {
      const client = await redis.ensureConnected().catch(() => null)
      if (client) {
        await client
          .eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
            {
              keys: [MAINTENANCE_LOCK_KEY],
              arguments: [maintenanceId],
            },
          )
          .catch(() => undefined)
      }
    }
    await preview.onModuleDestroy()
    await redis.onModuleDestroy()
    await db.onModuleDestroy()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
