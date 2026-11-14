import { Injectable } from '@nestjs/common'
import type { RequestHandler } from 'express'
import session from 'express-session'
import { RedisStore } from 'connect-redis'
import { AppConfigService } from '../config/config.module'
import { RedisService } from '../redis/redis.module'

const SESSION_PREFIX = 'paimeng:sess:'

@Injectable()
export class SessionService {
  private store: RedisStore | null = null
  private handler: RequestHandler | null = null

  constructor(private readonly config: AppConfigService, private readonly redis: RedisService) {
    const client = this.redis.client
    this.store = new RedisStore({
      client: client as never,
      prefix: SESSION_PREFIX,
      ttl: Math.floor(this.config.sessionTtlMs / 1000),
    })
    const secure = this.config.mainOrigin.startsWith('https://')
    this.handler = session({
      name: 'pm_sid',
      store: this.store as never,
      secret: this.config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: this.config.sessionTtlMs,
        path: '/',
      },
    })
  }

  middleware(): RequestHandler {
    if (!this.handler) throw new Error('SessionService 尚未初始化')
    return this.handler
  }

  async exists(sessionId: string): Promise<boolean> {
    const client = await this.redis.ensureConnected()
    const value = await client.exists(`${SESSION_PREFIX}${sessionId}`)
    return value === 1
  }
}
