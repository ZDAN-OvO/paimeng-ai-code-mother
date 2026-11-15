import { Controller, Get, Res } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { Public, RawResponse } from '../common/http'
import { DbService } from '../db/db.module'
import { RedisService } from '../redis/redis.module'
import { RuntimeService } from '../runtime/runtime.service'
import { Logger } from '@nestjs/common'
import type { z } from 'zod'
import { HealthResult, ReadinessResult, healthSchema } from './dto'

@ApiTags('health')
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
  @ApiOperation({ summary: '存活检查' })
  @ApiOkResponse({ type: HealthResult })
  health(): z.output<typeof healthSchema> {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }
  }

  @Public()
  @RawResponse()
  @Get('health/ready')
  @ApiOperation({ summary: '就绪检查' })
  @ApiOkResponse({ type: ReadinessResult })
  @ApiResponse({ status: 503, type: ReadinessResult, description: '依赖不可用' })
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
