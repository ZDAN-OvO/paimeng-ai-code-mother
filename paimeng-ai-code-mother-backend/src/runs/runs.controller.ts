import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common'
import { ApiBody, ApiExtraModels, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import type { z } from 'zod'
import { CurrentUser, RawResponse } from '../common/http'
import type { AppUIMessageChunk } from '../conversations/ui-message'
import {
  BaseResponseCancelRun,
  BaseResponseRunActivityList,
  BaseResponseRunChangePage,
  BaseResponseRunDetails,
  BaseResponseRunDiffPage,
  BaseResponseRunStatus,
  BaseResponseRunValidationLog,
  CancelRunDto,
  ChatDto,
  RunActivitiesQueryDto,
  RunChangeDiffQueryDto,
  RunChangesQueryDto,
  RunDetailsQueryDto,
  PhaseChunk,
  RunChunk,
  RunStartedChunk,
  RunStatusQueryDto,
  RunValidationLogQueryDto,
  cancelRunResultSchema,
  runActivitySchema,
  runChangePageSchema,
  runDetailsSchema,
  runDiffPageSchema,
  runStatusSchema,
  runValidationLogSchema,
  BaseResponseQueueItem,
  BaseResponseMessageQueue,
  EnqueueMessageDto,
  MessageQueueQueryDto,
  RemoveQueuedMessageDto,
  ResumeMessageQueueDto,
  queueItemSchema,
  messageQueueSchema,
} from './dto'
import { RunDetailsService } from './run-details.service'
import { RunsService } from './runs.service'

@ApiTags('run')
@ApiExtraModels(RunStartedChunk, PhaseChunk, RunChunk)
@Controller()
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly details: RunDetailsService,
  ) {}

  @RawResponse()
  @ApiBody({ type: ChatDto })
  @ApiResponse({
    status: 200,
    description: 'Vercel AI SDK UI Message Stream；运行状态通过 transient data-run 传递。',
    content: {
      'text/event-stream': {
        schema: { type: 'string' },
      },
    },
  })
  @Post('app/chat/gen/code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送消息并流式返回 Agent 输出' })
  async chat(
    @Body() dto: ChatDto,
    @CurrentUser() userId: number,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    const started = await this.runs.startRun(userId, dto.appId, dto.message, dto.clientRequestId)
    return this.writeRunStream(started.runId, res)
  }

  @RawResponse()
  @Post('app/run/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '订阅运行输出，断开订阅不停止运行' })
  @ApiBody({ type: CancelRunDto })
  @ApiResponse({
    status: 200,
    description: 'Vercel AI SDK UI Message Stream',
    content: {
      'text/event-stream': { schema: { type: 'string' } },
    },
  })
  async subscribeRun(@Body() dto: CancelRunDto, @CurrentUser() userId: number, @Res() res: Response) {
    await this.runs.getRunStatus(userId, { runId: dto.runId })
    return this.writeRunStream(dto.runId, res)
  }

  @Post('app/chat/queue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '将普通消息或插话加入发送队列' })
  @ApiOkResponse({ type: BaseResponseQueueItem })
  async enqueueMessage(
    @Body() dto: EnqueueMessageDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof queueItemSchema>> {
    return this.runs.enqueueMessage(userId, dto)
  }

  @Get('app/chat/queue')
  @ApiOperation({ summary: '查询待发送消息、未生效插话和当前运行' })
  @ApiOkResponse({ type: BaseResponseMessageQueue })
  async getMessageQueue(
    @Query() dto: MessageQueueQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof messageQueueSchema>> {
    return this.runs.getMessageQueue(userId, dto.appId, dto.clientRequestId)
  }

  @Post('app/chat/queue/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '移除尚未处理的排队消息' })
  @ApiOkResponse({ type: BaseResponseMessageQueue })
  async removeQueuedMessage(
    @Body() dto: RemoveQueuedMessageDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof messageQueueSchema>> {
    return this.runs.removeQueuedMessage(userId, dto.appId, dto.id)
  }

  @Post('app/chat/queue/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '继续普通消息队列' })
  @ApiOkResponse({ type: BaseResponseMessageQueue })
  async resumeMessageQueue(
    @Body() dto: ResumeMessageQueueDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof messageQueueSchema>> {
    return this.runs.resumeMessageQueue(userId, dto.appId)
  }

  private async writeRunStream(runId: string, res: Response) {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('x-vercel-ai-ui-message-stream', 'v1')
    res.flushHeaders()

    const write = (chunk: AppUIMessageChunk | null) => {
      if (chunk === null) {
        res.write('data: [DONE]\n\n')
        return
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    const stream = this.runs.getStream(runId)
    if (!stream) {
      const [final, replay] = await Promise.all([
        this.runs.latestFinishedEvent(runId),
        this.runs.replayChunks(runId),
      ])
      if (replay.length) {
        for (const chunk of replay) write(chunk)
      } else {
        write({ type: 'start', messageId: `assistant:${runId}` })
      }
      write({
        type: 'data-run',
        id: `run:${runId}`,
        transient: true,
        data: {
          runId,
          ...(final ?? {}),
          status: final?.status ?? 'failed',
        },
      })
      write({ type: 'finish' })
      write(null)
      res.end()
      return
    }

    let closed = false
    let unsubscribe: () => void = () => undefined
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    }
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n')
    }, 15_000)
    unsubscribe = stream.subscribe((chunk) => {
      if (!chunk) {
        cleanup()
        write(null)
        res.end()
        return
      }
      write(chunk)
    })
    res.on('close', () => {
      cleanup()
    })
  }

  @Get('app/run/status')
  @ApiOperation({ summary: '查询运行状态' })
  @ApiOkResponse({ type: BaseResponseRunStatus })
  async getRunStatus(
    @Query() query: RunStatusQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runStatusSchema>> {
    return this.runs.getRunStatus(userId, query) as Promise<z.output<typeof runStatusSchema>>
  }

  @Post('app/run/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '取消运行' })
  @ApiOkResponse({ type: BaseResponseCancelRun })
  async cancelRun(
    @Body() dto: CancelRunDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof cancelRunResultSchema>> {
    return this.runs.cancelRun(userId, dto.runId) as Promise<z.output<typeof cancelRunResultSchema>>
  }

  @Get('app/run/details')
  @ApiOperation({ summary: '获取运行详情' })
  @ApiOkResponse({ type: BaseResponseRunDetails })
  async getRunDetails(
    @Query() query: RunDetailsQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runDetailsSchema>> {
    return this.details.getDetails(userId, query.runId) as Promise<z.output<typeof runDetailsSchema>>
  }

  @Get('app/run/activities')
  @ApiOperation({ summary: '分页读取运行活动' })
  @ApiOkResponse({ type: BaseResponseRunActivityList })
  async listRunActivities(
    @Query() query: RunActivitiesQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runActivitySchema>[]> {
    return this.details.listActivities(userId, query.runId, query.afterId, query.limit ?? 200) as Promise<
      z.output<typeof runActivitySchema>[]
    >
  }

  @Get('app/run/changes')
  @ApiOperation({ summary: '分页读取运行变更' })
  @ApiOkResponse({ type: BaseResponseRunChangePage })
  async listRunChanges(
    @Query() query: RunChangesQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runChangePageSchema>> {
    return this.details.listChanges(userId, query.runId, query.cursor, query.limit ?? 100) as Promise<
      z.output<typeof runChangePageSchema>
    >
  }

  @Get('app/run/change')
  @ApiOperation({ summary: '读取单文件变更 diff' })
  @ApiOkResponse({ type: BaseResponseRunDiffPage })
  async getRunDiff(
    @Query() query: RunChangeDiffQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runDiffPageSchema>> {
    return this.details.getChangeDiff(
      userId,
      query.runId,
      query.fileId,
      query.cursor ?? 0,
      query.limit ?? 200,
    ) as Promise<z.output<typeof runDiffPageSchema>>
  }

  @Get('app/run/validation/log')
  @ApiOperation({ summary: '读取验证日志' })
  @ApiOkResponse({ type: BaseResponseRunValidationLog })
  async getValidationLog(
    @Query() query: RunValidationLogQueryDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof runValidationLogSchema>> {
    return this.details.getValidationLog(userId, query.runId, query.attempt, query.check) as Promise<
      z.output<typeof runValidationLogSchema>
    >
  }
}
