import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import type { z } from 'zod'
import { ApiException } from '../common/api'
import { CurrentUser } from '../common/http'
import { AppsService } from '../apps/apps.service'
import {
  AppIdDto,
  BaseResponseBoolean,
  BaseResponsePreviewAccess,
  BaseResponsePreviewStart,
  BaseResponsePreviewStatus,
  PreviewStatusQueryDto,
  previewAccessSchema,
  previewStartSchema,
  previewStatusSchemaValue,
} from './dto'
import { PreviewService } from './preview.service'

@ApiTags('preview')
@Controller()
export class PreviewController {
  constructor(
    private readonly preview: PreviewService,
    private readonly apps: AppsService,
  ) {}

  @Post('app/preview/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '启动或复用预览环境' })
  @ApiOkResponse({ type: BaseResponsePreviewStart })
  async startPreview(
    @Body() dto: AppIdDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof previewStartSchema>> {
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
  @ApiOperation({ summary: '查询预览状态' })
  @ApiOkResponse({ type: BaseResponsePreviewStatus })
  async getPreviewStatus(
    @Query() query: PreviewStatusQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof previewStatusSchemaValue>> {
    await this.apps.findOwnedApp(query.appId, userId)
    return this.preview.getStatus(query.appId)
  }

  @Post('app/preview/access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '签发预览访问票据' })
  @ApiOkResponse({ type: BaseResponsePreviewAccess })
  async requestPreviewAccess(
    @Body() dto: AppIdDto,
    @CurrentUser() userId: number,
    @Req() req: Request,
  ): Promise<z.output<typeof previewAccessSchema>> {
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '续期预览访问授权' })
  @ApiOkResponse({ type: BaseResponseBoolean })
  async sendPreviewHeartbeat(@Body() dto: AppIdDto, @CurrentUser() userId: number, @Req() req: Request) {
    await this.apps.findOwnedApp(dto.appId, userId)
    return this.preview.heartbeat(dto.appId, req.sessionID)
  }
}
