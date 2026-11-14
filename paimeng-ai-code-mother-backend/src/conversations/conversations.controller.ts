import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiException } from '../common/api'
import { CurrentUser } from '../common/http'
import { ConversationsService } from './conversations.service'

@Controller('chatHistory')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get('app/:appId')
  history(
    @CurrentUser() userId: number,
    @Param('appId') appId: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const id = Number(appId)
    if (!Number.isInteger(id) || id <= 0) throw ApiException.badRequest('应用 ID 无效')
    const size = pageSize === undefined ? undefined : Number(pageSize)
    return this.conversations.getHistory(userId, {
      appId: id,
      cursor,
      pageSize: Number.isFinite(size) ? size : undefined,
    })
  }
}
