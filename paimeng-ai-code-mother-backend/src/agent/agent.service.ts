import { Injectable, Logger } from '@nestjs/common'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, type ModelMessage } from 'ai'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppConfigService } from '../config/config.module'
import { PreviewService } from '../preview/preview.service'
import { RuntimeService } from '../runtime/runtime.service'
import { SkillService } from '../skills/skill.service'
import { ToolRegistryService } from '../tools/tool-registry.service'
import { buildSystemPrompt } from './system-prompt'
import { checkContextBudget } from './context-budget'
import { evaluateRunLimits } from './run-limits'
import { SessionStoreService } from './session-store.service'
import { ToolContext } from '../runtime/file-service'
import { describeError, errMessage, truncateBytes } from '../common/truncate'
import { RunDetailsService } from '../runs/run-details.service'
import { RunProgress } from './run-progress'
import { readModelStream, type ModelToolCall } from './model-stream'
import { RUN_ERROR_CODES } from '../common/api'

export type RunStatus = 'completed' | 'failed' | 'cancelled'

export interface AgentRunInput {
  runId: string
  appId: number
  conversationId: number
  deadlineAt: Date
  signal: AbortSignal
  emit: (type: string, payload?: Record<string, unknown>) => void
  setPhase: (phase: string) => void
  onStep?: (stepCount: number) => void
  isCancelled: () => boolean
}

export interface AgentOutcome {
  status: RunStatus
  text: string
  stepCount: number
  repairCount: number
  errorCode?: string
  errorSummary?: string
}

interface ValidationResult {
  ok: boolean
  summary: string
  logs: string
}

const PHASE = {
  prepare: 'prepare',
  generate: 'generate',
  install: 'install',
  validate: 'validate',
  repair: 'repair',
  finish: 'finish',
} as const

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name)

  constructor(
    private readonly config: AppConfigService,
    private readonly store: SessionStoreService,
    private readonly tools: ToolRegistryService,
    private readonly skills: SkillService,
    private readonly runtime: RuntimeService,
    private readonly preview: PreviewService,
    private readonly details: RunDetailsService,
  ) {}

  async execute(input: AgentRunInput): Promise<AgentOutcome> {
    const progress = new RunProgress()
    let incompleteTurns = 0
    const ctx: ToolContext = {
      appId: input.appId,
      runId: input.runId,
      isCancelled: input.isCancelled,
      readVersions: new Map(),
      markPreviewChanged: () => this.preview.markChanged(input.appId),
      markMutated: () => {
        progress.markMutated()
        incompleteTurns = 0
      },
      emit: input.emit,
    }
    const toolDefinitions = this.tools.definitionsForModel()
    const toolSchemas = this.tools.modelToolSchemas()
    const provider = createOpenAI({ baseURL: this.config.aiBaseUrl, apiKey: this.config.aiApiKey })
    const model = provider.responses(this.config.aiModel)

    let stepCount = 0
    let repairCount = 0
    let lastValidation: ValidationResult | null = null
    const texts: string[] = []
    let entries = await this.store.list(input.conversationId)

    input.setPhase(PHASE.prepare)
    const detected = await this.runtime.detectProject(input.appId)
    const kind = detected.hasPackageJson ? detected.kind : 'static'
    let skills
    try {
      skills = await this.skills.list()
    } catch (err) {
      return {
        status: 'failed',
        text: '',
        stepCount: 0,
        repairCount: 0,
        errorCode: 'SKILL_REGISTRY_ERROR',
        errorSummary: `技能注册表加载失败：${errMessage(err)}`,
      }
    }
    const system = buildSystemPrompt(kind, input.appId, skills)

    while (true) {
      const blocked = this.controlFailure(input, stepCount)
      if (blocked) {
        return {
          status: blocked.status,
          text: texts.join('\n\n'),
          stepCount,
          repairCount,
          errorCode: blocked.errorCode,
          errorSummary: blocked.errorSummary,
        }
      }
      const messages = this.store.toModelMessages(entries, this.config.toolOutputMaxBytes)
      const budget = checkContextBudget({
        system,
        messages,
        tools: toolSchemas as unknown as Record<string, unknown>,
        contextWindowTokens: this.config.aiContextWindowTokens,
        outputReserveTokens: this.config.aiOutputReserveTokens,
      })
      if (!budget.ok) {
        return {
          status: 'failed',
          text: texts.join('\n\n'),
          stepCount,
          repairCount,
          errorCode: 'CONTEXT_BUDGET_EXCEEDED',
          errorSummary: budget.message,
        }
      }

      input.setPhase(PHASE.generate)
      const call = await this.callModel(
        model,
        system,
        messages,
        toolDefinitions,
        input.signal,
        input.deadlineAt,
        (delta) => input.emit('text-delta', { text: delta }),
        (payload) => input.emit('model-status', { step: stepCount + 1, ...payload }),
      )
      if (call.kind === 'cancelled') {
        return {
          status: 'cancelled',
          text: [...texts, call.text].filter(Boolean).join('\n\n'),
          stepCount,
          repairCount,
        }
      }
      if (call.kind === 'failed') {
        return {
          status: 'failed',
          text: [...texts, call.text].filter(Boolean).join('\n\n'),
          stepCount,
          repairCount,
          errorCode: call.errorCode,
          errorSummary: call.errorSummary,
        }
      }
      stepCount += 1
      input.onStep?.(stepCount)
      if (call.text.trim()) texts.push(call.text)

      const invalidCalls = call.toolCalls.filter((toolCall) => toolCall.invalid)
      const incomplete = call.finishReason === 'length' || invalidCalls.length > 0
      if (incomplete) incompleteTurns += 1
      const recoveryNote =
        `本次模型输出${call.finishReason === 'length' ? `达到 ${this.config.aiOutputReserveTokens} tokens 上限并被截断` : '包含无效工具参数'}。` +
        '未完成的工具调用不会写入文件。请不要重发相同的大文件；把代码拆成多个独立的 CSS/JS 模块，每次工具参数总量不超过 6000 字符。' +
        '已有文件先 read，再用唯一匹配的小段 edit 追加；减少示例文章长度，优先完成可运行功能。'

      if (call.toolCalls.length > 0) {
        await this.store.append(input.conversationId, input.runId, 'assistant', {
          text: call.text,
          toolCalls: call.toolCalls,
        })
        for (let index = 0; index < call.toolCalls.length; index += 1) {
          const toolCall = call.toolCalls[index]
          if (input.isCancelled()) {
            // 已持久化的 assistant 工具调用必须补齐结果，否则恢复上下文时会出现
            // “有 tool-call 没有 tool-result”的非法消息序列。
            for (const pending of call.toolCalls.slice(index)) {
              await this.store.append(input.conversationId, input.runId, 'tool', {
                toolCallId: pending.toolCallId,
                toolName: pending.toolName,
                output: JSON.stringify({ error: '任务已取消，工具未执行' }),
              })
            }
            return { status: 'cancelled', text: texts.join('\n\n'), stepCount, repairCount }
          }
          ctx.toolCallId = toolCall.toolCallId
          let output: string
          if (toolCall.invalid) {
            output = JSON.stringify({ error: recoveryNote })
            input.emit('tool-finished', {
              tool: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              ok: false,
              error: recoveryNote,
            })
          } else {
            output = await this.tools.execute(ctx, toolCall.toolName, toolCall.input)
          }
          ctx.toolCallId = undefined
          await this.store.append(input.conversationId, input.runId, 'tool', {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output,
          })
        }
        if (incompleteTurns >= 3) {
          return {
            status: 'failed',
            text: texts.join('\n\n'),
            stepCount,
            repairCount,
            errorCode:
              call.finishReason === 'length'
                ? RUN_ERROR_CODES.MODEL_OUTPUT_LIMIT
                : RUN_ERROR_CODES.MODEL_OUTPUT_INVALID,
            errorSummary:
              '模型在未产生文件变更期间累计 3 次返回截断或无效的工具调用，已停止重复生成，请缩小本轮需求后继续。',
          }
        }
        if (incomplete) {
          await this.store.append(input.conversationId, input.runId, 'system_note', { text: recoveryNote })
        }
        entries = await this.store.list(input.conversationId)
        continue
      }

      if (call.text) {
        await this.store.append(input.conversationId, input.runId, 'assistant', {
          text: call.text,
          toolCalls: [],
        })
      }
      if (incomplete) {
        if (incompleteTurns >= 3) {
          return {
            status: 'failed',
            text: texts.join('\n\n'),
            stepCount,
            repairCount,
            errorCode: RUN_ERROR_CODES.MODEL_OUTPUT_LIMIT,
            errorSummary: '模型连续 3 次达到输出上限，未提交完整实现。',
          }
        }
        await this.store.append(input.conversationId, input.runId, 'system_note', { text: recoveryNote })
        entries = await this.store.list(input.conversationId)
        continue
      }
      const decision = progress.onTextOnlyTurn()
      if (decision.action === 'prompt') {
        await this.store.append(input.conversationId, input.runId, 'system_note', {
          text: decision.note,
        })
        entries = await this.store.list(input.conversationId)
        continue
      }
      if (decision.action === 'fail') {
        const errorSummary =
          decision.errorCode === 'VALIDATION_FAILED' && lastValidation
            ? `验证失败后没有产生新的修复变更：${lastValidation.summary}`
            : decision.errorSummary
        return {
          status: 'failed',
          text: texts.join('\n\n') || errorSummary,
          stepCount,
          repairCount,
          errorCode: decision.errorCode,
          errorSummary,
        }
      }
      input.emit('validation-status', { status: 'running', attempt: repairCount + 1 })
      const validation = await this.validate(input, repairCount + 1)
      lastValidation = validation
      if (input.isCancelled()) {
        return { status: 'cancelled', text: texts.join('\n\n'), stepCount, repairCount }
      }
      if (validation.ok) {
        input.emit('validation-status', { status: 'passed', attempt: repairCount + 1 })
        input.setPhase(PHASE.finish)
        return { status: 'completed', text: texts.join('\n\n'), stepCount, repairCount }
      }
      input.emit('validation-status', {
        status: 'failed',
        attempt: repairCount + 1,
        message: validation.summary,
      })
      if (repairCount >= 3) {
        return {
          status: 'failed',
          text: texts.join('\n\n'),
          stepCount,
          repairCount,
          errorCode: 'VALIDATION_FAILED',
          errorSummary: `验证失败且已用完 3 次修复机会：${validation.summary}`,
        }
      }
      repairCount += 1
      input.setPhase(PHASE.repair)
      await this.store.append(input.conversationId, input.runId, 'system_note', {
        text: `平台验证失败（第 ${repairCount} 次修复请求），请修复后重新提交完整实现。\n${JSON.stringify(
          { summary: validation.summary, logs: truncateBytes(validation.logs, 20_000).text },
          null,
          2,
        )}`,
      })
      entries = await this.store.list(input.conversationId)
    }
  }

  private controlFailure(
    input: AgentRunInput,
    stepCount: number,
  ): { status: RunStatus; errorCode?: string; errorSummary?: string } | null {
    return evaluateRunLimits({
      cancelled: input.isCancelled(),
      stepCount,
      maxSteps: this.config.runMaxSteps,
      now: Date.now(),
      deadlineAt: input.deadlineAt.getTime(),
      maxDurationMs: this.config.runMaxDurationMs,
    })
  }

  private async callModel(
    model: ReturnType<ReturnType<typeof createOpenAI>['responses']>,
    system: string,
    messages: ModelMessage[],
    tools: Record<string, unknown>,
    runSignal: AbortSignal,
    deadlineAt: Date,
    onDelta: (delta: string) => void,
    onProgress: (payload: Record<string, unknown>) => void,
  ): Promise<
    | { kind: 'ok'; text: string; toolCalls: ModelToolCall[]; finishReason: string }
    | { kind: 'cancelled'; text: string }
    | { kind: 'failed'; text: string; errorCode: string; errorSummary: string }
  > {
    const timeout = AbortSignal.timeout(this.config.modelTimeoutMs)
    const remaining = Math.max(0, deadlineAt.getTime() - Date.now())
    const deadline = AbortSignal.timeout(remaining)
    const requestAbort = new AbortController()
    const signal = AbortSignal.any([runSignal, timeout, deadline, requestAbort.signal])
    let partialText = ''
    onProgress({ status: 'running' })
    try {
      const result = streamText({
        model: model as never,
        system,
        messages,
        tools: tools as never,
        toolChoice: 'auto',
        maxRetries: 0,
        allowSystemInMessages: true,
        abortSignal: signal,
        maxOutputTokens: this.config.aiOutputReserveTokens,
        onError: () => undefined,
      })
      const turn = await readModelStream(
        result.fullStream,
        (delta) => {
          partialText += delta
          onDelta(delta)
        },
        onProgress,
      )
      if (signal.aborted) throw new Error('模型请求已中止')
      onProgress({ status: 'finished', ...turn.metrics })
      return {
        kind: 'ok',
        text: turn.text,
        toolCalls: turn.toolCalls,
        finishReason: turn.finishReason,
      }
    } catch (err) {
      requestAbort.abort(err)
      onProgress({ status: 'failed' })
      if (runSignal.aborted) return { kind: 'cancelled', text: partialText }
      const message = errMessage(err)
      if (deadline.aborted || Date.now() >= deadlineAt.getTime()) {
        return {
          kind: 'failed',
          text: partialText,
          errorCode: 'RUN_TIMEOUT',
          errorSummary: '任务总时长已达到上限，已停止当前工作',
        }
      }
      if (timeout.aborted) {
        return {
          kind: 'failed',
          text: partialText,
          errorCode: 'MODEL_TIMEOUT',
          errorSummary: `模型请求超时（${Math.round(this.config.modelTimeoutMs / 1000)} 秒）`,
        }
      }
      if (/context length|context_length|too many tokens|maximum context|token limit/i.test(message)) {
        return {
          kind: 'failed',
          text: partialText,
          errorCode: 'CONTEXT_LIMIT_REJECTED',
          errorSummary: `模型网关拒绝请求：上下文超出限制。${message}`,
        }
      }
      const described = describeError(err)
      const cause = (err as { cause?: unknown }).cause
      this.logger.warn(
        `模型请求失败: ${described.name}: ${described.message}${cause ? ` | cause: ${errMessage(cause)}` : ''}`,
      )
      return {
        kind: 'failed',
        text: partialText,
        errorCode: 'MODEL_ERROR',
        errorSummary: `模型请求失败：${message}`,
      }
    }
  }

  private async recordValidation(
    input: AgentRunInput,
    attempt: number,
    check: string,
    status: 'running' | 'passed' | 'failed' | 'skipped',
    summary?: string,
    logs?: string,
  ) {
    await this.details
      .recordValidationLog({
        runId: input.runId,
        appId: input.appId,
        attempt,
        checkName: check,
        status,
        summary: summary ?? null,
        logs: logs ?? null,
      })
      .catch((err) =>
        this.logger.warn(`验证记录 ${check} 保存失败: ${err instanceof Error ? err.message : String(err)}`),
      )
    input.emit('validation-status', { status, attempt, check, message: summary })
  }

  private async validate(input: AgentRunInput, attempt: number): Promise<ValidationResult> {
    if (input.isCancelled()) {
      await this.recordValidation(input, attempt, 'run', 'failed', '任务已取消')
      return { ok: false, summary: '任务已取消', logs: '' }
    }
    const source = await this.runtime.sourceStats(input.appId)
    if (source.files === 0) {
      await this.recordValidation(input, attempt, 'source', 'failed', '项目目录没有任何源文件')
      return { ok: false, summary: '项目目录没有任何源文件', logs: '' }
    }
    await this.recordValidation(input, attempt, 'source', 'passed', `${source.files} 个源文件`)
    const info = await this.runtime.detectProject(input.appId)
    if (info.manifestError) {
      await this.recordValidation(input, attempt, 'manifest', 'failed', info.manifestError)
      return { ok: false, summary: `package.json 无效：${info.manifestError}`, logs: '' }
    }
    await this.recordValidation(input, attempt, 'manifest', 'passed')
    input.setPhase(PHASE.install)
    if (info.hasPackageJson) {
      await this.recordValidation(input, attempt, 'install', 'running')
      const deps = await this.runtime.ensureDependencies(input.appId, input.isCancelled)
      if (!deps.ok) {
        await this.recordValidation(input, attempt, 'install', 'failed', deps.error, deps.logs)
        return {
          ok: false,
          summary: deps.error ?? '依赖安装失败',
          logs: deps.logs,
        }
      }
      await this.recordValidation(input, attempt, 'install', 'passed')
      if (info.hasTypecheck) {
        input.setPhase(PHASE.validate)
        await this.recordValidation(input, attempt, 'typecheck', 'running')
        const typecheck = await this.runtime.typecheck(input.appId, input.isCancelled)
        if (!typecheck.ok) {
          await this.recordValidation(input, attempt, 'typecheck', 'failed', typecheck.error, typecheck.logs)
          return { ok: false, summary: typecheck.error ?? '静态检查失败', logs: typecheck.logs }
        }
        await this.recordValidation(input, attempt, 'typecheck', 'passed')
      } else {
        await this.recordValidation(input, attempt, 'typecheck', 'skipped', '项目未配置类型检查')
      }
      if (info.hasBuild) {
        input.setPhase(PHASE.validate)
        await this.recordValidation(input, attempt, 'build', 'running')
        const build = await this.runtime.build(input.appId, input.isCancelled)
        if (!build.ok) {
          await this.recordValidation(input, attempt, 'build', 'failed', build.error, build.logs)
          return { ok: false, summary: build.error ?? '构建失败', logs: build.logs }
        }
        await this.recordValidation(input, attempt, 'build', 'passed')
      } else {
        await this.recordValidation(input, attempt, 'build', 'skipped', '项目未配置构建脚本')
      }
    } else {
      await this.recordValidation(input, attempt, 'install', 'skipped', '静态项目无需安装依赖')
      await this.recordValidation(input, attempt, 'typecheck', 'skipped', '静态项目无需类型检查')
      await this.recordValidation(input, attempt, 'build', 'skipped', '静态项目无需构建')
    }
    if (info.hasPackageJson && (info.kind === 'vue' || info.kind === 'react')) {
      input.setPhase(PHASE.validate)
      await this.recordValidation(input, attempt, 'preview', 'running')
      const preview = await this.preview.ensurePreview(input.appId, input.isCancelled)
      input.emit('preview-status', {
        status: preview.status,
        kind: info.kind,
        url: preview.status === 'running' ? this.config.previewUrl(input.appId) : undefined,
        error: preview.error,
      })
      if (preview.status !== 'running') {
        const logs = await this.runtime.previewContainerLogs(input.appId)
        await this.recordValidation(input, attempt, 'preview', 'failed', preview.error, logs)
        return {
          ok: false,
          summary: preview.error ?? '预览启动失败',
          logs,
        }
      }
      await this.recordValidation(input, attempt, 'preview', 'passed')
    } else {
      await this.recordValidation(input, attempt, 'preview', 'running')
      if (!existsSync(join(this.config.appSourceDir(input.appId), 'index.html'))) {
        await this.recordValidation(input, attempt, 'preview', 'failed', '静态项目缺少入口文件 index.html')
        return { ok: false, summary: '静态项目缺少入口文件 index.html', logs: '' }
      }
      await this.preview.stopForStatic(input.appId)
      await this.runtime.cleanupBuildDeps(input.appId)
      this.preview.markChanged(input.appId)
      input.emit('preview-status', {
        status: 'running',
        kind: 'static',
        url: this.config.previewUrl(input.appId),
      })
      await this.recordValidation(input, attempt, 'preview', 'passed')
    }
    return { ok: true, summary: '验证通过', logs: '' }
  }
}
