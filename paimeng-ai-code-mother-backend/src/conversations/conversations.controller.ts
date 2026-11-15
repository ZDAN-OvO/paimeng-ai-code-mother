import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { z } from 'zod'
import { CurrentUser } from '../common/http'
import { ConversationsService } from './conversations.service'
import {
  AppIdParamDto,
  BaseResponseChatHistory,
  ChatHistoryQueryDto,
  ChatUIMessage,
  UIMessagePart,
  chatHistorySchema,
} from './dto'

@ApiTags('chatHistory')
@ApiExtraModels(ChatUIMessage, UIMessagePart)
@Controller('chatHistory')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get('app/:appId')
  @ApiOperation({ summary: '分页读取应用对话历史' })
  @ApiOkResponse({ type: BaseResponseChatHistory })
  listAppChatHistory(
    @CurrentUser() userId: number,
    @Param() params: AppIdParamDto,
    @Query() query: ChatHistoryQueryDto,
  ): Promise<z.output<typeof chatHistorySchema>> {
    return this.conversations.getHistory(userId, {
      appId: params.appId,
      cursor: query.cursor,
      pageSize: query.pageSize,
    }) as Promise<z.output<typeof chatHistorySchema>>
  }
}
