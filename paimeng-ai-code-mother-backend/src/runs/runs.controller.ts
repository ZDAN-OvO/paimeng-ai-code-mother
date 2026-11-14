import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common'
import { ApiBody, ApiResponse } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { ApiException } from '../common/api'
import { CurrentUser, RawResponse } from '../common/http'
import type { AppUIMessageChunk } from '../conversations/ui-message'
import { CancelDto, ChatDto } from './dto'
import { RunDetailsService } from './run-details.service'
import { RunsService } from './runs.service'

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
  async status(
    @Query('runId') runId: string | undefined,
    @Query('appId') appIdRaw: string | undefined,
    @Query('clientRequestId') clientRequestId: string | undefined,
    @CurrentUser() userId: number,
  ) {
    if (runId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw ApiException.badRequest('runId 格式无效')
    }
    if (clientRequestId && (clientRequestId.length < 8 || clientRequestId.length > 100)) {
      throw ApiException.badRequest('clientRequestId 长度需在 8-100 之间')
    }
    const appId = appIdRaw === undefined ? undefined : Number(appIdRaw)
    if (appId !== undefined && (!Number.isInteger(appId) || appId <= 0)) {
      throw ApiException.badRequest('应用 ID 无效')
    }
    return this.runs.getRunStatus(userId, { runId, appId, clientRequestId })
  }

  @Post('app/run/cancel')
  async cancel(@Body() dto: CancelDto, @CurrentUser() userId: number) {
    return this.runs.cancelRun(userId, dto.runId)
  }

  @Get('app/run/details')
  async runDetails(@Query('runId') runId: string, @CurrentUser() userId: number) {
    return this.details.getDetails(userId, this.parseRunId(runId))
  }

  @Get('app/run/activities')
  async activities(
    @Query('runId') runId: string,
    @Query('afterId') afterIdRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() userId: number,
  ) {
    const afterId = afterIdRaw === undefined ? undefined : Number(afterIdRaw)
    if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) {
      throw ApiException.badRequest('afterId 无效')
    }
    const limit = limitRaw === undefined ? 200 : Number(limitRaw)
    if (!Number.isFinite(limit)) throw ApiException.badRequest('limit 无效')
    return this.details.listActivities(userId, this.parseRunId(runId), afterId, limit)
  }

  @Get('app/run/changes')
  async changes(
    @Query('runId') runId: string,
    @Query('cursor') cursorRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() userId: number,
  ) {
    const cursor = cursorRaw === undefined ? undefined : Number(cursorRaw)
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
      throw ApiException.badRequest('cursor 无效')
    }
    const limit = limitRaw === undefined ? 100 : Number(limitRaw)
    if (!Number.isFinite(limit)) throw ApiException.badRequest('limit 无效')
    return this.details.listChanges(userId, this.parseRunId(runId), cursor, limit)
  }

  @Get('app/run/change')
  async change(
    @Query('runId') runId: string,
    @Query('fileId') fileIdRaw: string,
    @Query('cursor') cursorRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() userId: number,
  ) {
    const fileId = Number(fileIdRaw)
    if (!Number.isInteger(fileId) || fileId <= 0) throw ApiException.badRequest('fileId 无效')
    const cursor = cursorRaw === undefined ? 0 : Number(cursorRaw)
    if (!Number.isInteger(cursor) || cursor < 0) throw ApiException.badRequest('cursor 无效')
    const limit = limitRaw === undefined ? 200 : Number(limitRaw)
    if (!Number.isFinite(limit)) throw ApiException.badRequest('limit 无效')
    return this.details.getChangeDiff(userId, this.parseRunId(runId), fileId, cursor, limit)
  }

  @Get('app/run/validation/log')
  async validationLog(
    @Query('runId') runId: string,
    @Query('attempt') attemptRaw: string,
    @Query('check') check: string,
    @CurrentUser() userId: number,
  ) {
    const attempt = Number(attemptRaw)
    if (!Number.isInteger(attempt) || attempt <= 0) throw ApiException.badRequest('attempt 无效')
    if (!check || check.length > 40) throw ApiException.badRequest('check 无效')
    return this.details.getValidationLog(userId, this.parseRunId(runId), attempt, check)
  }

  private parseRunId(runId: string | undefined) {
    if (!runId) throw ApiException.badRequest('缺少 runId')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw ApiException.badRequest('runId 格式无效')
    }
    return runId
  }
}
