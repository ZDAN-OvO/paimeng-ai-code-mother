import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common'
import { createZodDto } from 'nestjs-zod'
import type { Request } from 'express'
import { z } from 'zod'
import { ApiException } from '../common/api'
import { CurrentUser } from '../common/http'
import { AppsService } from '../apps/apps.service'
import { PreviewService } from './preview.service'

export const appIdSchema = z.object({ appId: z.number().int().positive() })
export class AppIdDto extends createZodDto(appIdSchema) {}

@Controller()
export class PreviewController {
  constructor(
    private readonly preview: PreviewService,
    private readonly apps: AppsService,
  ) {}

  @Post('app/preview/start')
  async start(@Body() dto: AppIdDto, @CurrentUser() userId: number) {
    const app = await this.apps.findOwnedApp(dto.appId, userId)
    if (app.status !== 'active') throw ApiException.conflict('应用正在删除，无法启动预览')
    const result = await this.preview.ensurePreview(dto.appId)
    return {
      status: result.status,
      error: result.error ?? null,
      url: result.status === 'running' ? this.preview.previewUrl(dto.appId) : null,
    }
  }

  @Get('app/preview/status')
  async status(@Query('appId') appIdRaw: string, @CurrentUser() userId: number) {
    const appId = Number(appIdRaw)
    if (!Number.isInteger(appId) || appId <= 0) throw ApiException.badRequest('应用 ID 无效')
    await this.apps.findOwnedApp(appId, userId)
    return this.preview.getStatus(appId)
  }

  @Post('app/preview/access')
  async access(@Body() dto: AppIdDto, @CurrentUser() userId: number, @Req() req: Request) {
    const app = await this.apps.findOwnedApp(dto.appId, userId)
    if (app.status !== 'active') throw ApiException.conflict('应用正在删除，无法访问预览')
    const ticket = await this.preview.issueTicket(dto.appId, userId, req.sessionID)
    return {
      ticket,
      url: this.preview.previewUrl(dto.appId),
      expiresInSeconds: this.preview.ticketTtlSeconds,
    }
  }

  @Post('app/preview/heartbeat')
  async heartbeat(@Body() dto: AppIdDto, @CurrentUser() userId: number, @Req() req: Request) {
    await this.apps.findOwnedApp(dto.appId, userId)
    return this.preview.heartbeat(dto.appId, req.sessionID)
  }
}
