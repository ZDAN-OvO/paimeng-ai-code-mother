import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Public, RawResponse } from '../common/http'
import { DbService } from '../db/db.module'
import { RedisService } from '../redis/redis.module'
import { RuntimeService } from '../runtime/runtime.service'
import { Logger } from '@nestjs/common'

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly runtime: RuntimeService,
  ) {}

  @Public()
  @RawResponse()
  @Get('health')
  health() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }
  }

  @Public()
  @RawResponse()
  @Get('health/ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, string> = {}
    try {
      await this.db.ping()
      checks.postgres = 'ok'
    } catch (err) {
      checks.postgres = err instanceof Error ? err.message : String(err)
    }
    try {
      await this.redis.ping()
      checks.redis = 'ok'
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : String(err)
    }
    try {
      const image = this.runtime.runtimeImageStatus
      checks.runtimeImage = image.error ? `error: ${image.error}` : image.image ? 'ok' : 'not-built'
    } catch (err) {
      checks.runtimeImage = err instanceof Error ? err.message : String(err)
    }
    const ready = Object.values(checks).every((value) => value === 'ok')
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', checks })
  }
}
