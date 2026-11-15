import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common'
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
  @ApiOperation({ summary: '发送消息并流式返回 Agent 输出' })
  async chat(
    @Body() dto: ChatDto,
    @CurrentUser() userId: number,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    const started = await this.runs.startRun(userId, dto.appId, dto.message, dto.clientRequestId)
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

    const stream = this.runs.getStream(started.runId)
    if (!stream) {
      const [final, replay] = await Promise.all([
        this.runs.latestFinishedEvent(started.runId),
        this.runs.replayChunks(started.runId),
      ])
      if (replay.length) {
        for (const chunk of replay) write(chunk)
      } else {
        write({ type: 'start', messageId: `assistant:${started.runId}` })
      }
      write({
        type: 'data-run',
        id: `run:${started.runId}`,
        transient: true,
        data: {
          runId: started.runId,
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
    // 只有浏览器主动离开/网络异常导致连接未正常结束时才取消运行。
    // 正常终态由 run-finished 后的 res.end() 标记 writableEnded，不会触发取消。
    const cancelIfAborted = () => {
      if (res.writableEnded) return
      void this.runs.cancelRun(userId, started.runId).catch(() => undefined)
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
      cancelIfAborted()
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
