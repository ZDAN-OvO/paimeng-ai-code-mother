import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { RedisService } from '../redis/redis.module'

export const INSTANCE_LOCK_KEY = 'paimeng:instance:lock'
export const MAINTENANCE_LOCK_KEY = 'paimeng:maintenance:lock'
const LOCK_TTL_MS = 15_000
const RENEW_MS = 5_000
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`

@Injectable()
export class InstanceLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InstanceLockService.name)
  private readonly instanceId = randomUUID()
  private timer: NodeJS.Timeout | null = null
  private held = false

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    const client = await this.redis.ensureConnected()
    if (await client.get(MAINTENANCE_LOCK_KEY)) {
      throw new Error('系统正在执行维护操作，拒绝启动后端')
    }
    let acquired = false
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      const result = await client.set(INSTANCE_LOCK_KEY, this.instanceId, {
        condition: 'NX',
        expiration: { type: 'PX', value: LOCK_TTL_MS },
      })
      acquired = result === 'OK'
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!acquired) {
      throw new Error('已存在另一个后端实例（单实例锁被占用），拒绝启动')
    }
    this.held = true
    this.timer = setInterval(() => void this.renew(), RENEW_MS)
    this.timer.unref()
    this.logger.log(`已获取单实例锁 ${this.instanceId}`)
  }

  private async renew() {
    if (!this.held) return
    try {
      const client = await this.redis.ensureConnected()
      const renewed = (await client.eval(RENEW_SCRIPT, {
        keys: [INSTANCE_LOCK_KEY],
        arguments: [this.instanceId, String(LOCK_TTL_MS)],
      })) as number
      if (Number(renewed) !== 1) {
        this.held = false
        this.logger.error('单实例锁续约失败，可能已被其他实例接管')
      }
    } catch (err) {
      this.logger.warn(`单实例锁续约异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
    if (!this.held) return
    this.held = false
    try {
      const client = await this.redis.ensureConnected()
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
      await client.eval(script, { keys: [INSTANCE_LOCK_KEY], arguments: [this.instanceId] })
    } catch {
      // ignore
    }
  }
}
