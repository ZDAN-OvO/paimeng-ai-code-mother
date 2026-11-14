import {
  readUIMessageStream,
  type DynamicToolUIPart,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type { PlanStep } from '../runs/run-details.service'

export interface PlanData {
  revision: number
  steps: PlanStep[]
}

export interface ValidationData {
  attempt: number
  check?: string
  status: 'running' | 'passed' | 'failed' | 'skipped'
  message?: string
}

export interface RunData {
  runId: string
  status?: string
  appId?: number
  phase?: string
  errorCode?: string | null
  errorSummary?: string | null
  [key: string]: unknown
}

export interface AppUIDataTypes extends UIDataTypes {
  plan: PlanData
  validation: ValidationData
  run: RunData
  phase: RunData
  model: Record<string, unknown>
  preview: Record<string, unknown>
}

export type AppUIMessage = UIMessage<unknown, AppUIDataTypes>
export type AppUIMessageChunk = UIMessageChunk<unknown, AppUIDataTypes>

export function userId(runId: string) {
  return `user:${runId}`
}

export function assistantId(runId: string) {
  return `assistant:${runId}`
}

export function userMessage(runId: string, text: string): AppUIMessage {
  return {
    id: userId(runId),
    role: 'user',
    parts: text ? [{ type: 'text', text, state: 'done' }] : [],
  }
}

export function assistantMessage(runId: string): AppUIMessage {
  return { id: assistantId(runId), role: 'assistant', parts: [] }
}

export function messageText(message: AppUIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export function appendText(message: AppUIMessage, text: string): AppUIMessage {
  if (!text) return message
  const parts = structuredClone(message.parts)
  const last = parts.at(-1)
  if (last?.type === 'text' && last.state !== 'streaming') last.text += text
  else parts.push({ type: 'text', text, state: 'done' })
  return { ...message, parts }
}

export function finishMessage(
  message: AppUIMessage | undefined,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  fallbackText = '',
): AppUIMessage {
  const source = structuredClone(message ?? assistantMessage(runId))
  if (!messageText(source) && fallbackText) {
    source.parts.push({ type: 'text', text: fallbackText, state: 'done' })
  }
  for (const part of source.parts) {
    if (part.type === 'text' && part.state === 'streaming') part.state = 'done'
    if (part.type !== 'dynamic-tool') continue
    if (part.state !== 'input-available' && part.state !== 'input-streaming') continue
    const mutable = part as DynamicToolUIPart & { state: string; errorText?: string }
    mutable.state = 'output-error'
    mutable.errorText =
      status === 'cancelled'
        ? '任务已取消，工具未完成'
        : status === 'failed'
          ? '任务失败，工具未完成'
          : '工具结果未确认'
  }
  return source
}

export function replayMessageChunks(message: AppUIMessage): AppUIMessageChunk[] {
  const chunks: AppUIMessageChunk[] = [{ type: 'start', messageId: message.id }]
  let textIndex = 0
  for (const part of message.parts) {
    if (part.type === 'text') {
      const id = `replay-text:${++textIndex}`
      chunks.push({ type: 'text-start', id })
      if (part.text) chunks.push({ type: 'text-delta', id, delta: part.text })
      chunks.push({ type: 'text-end', id })
      continue
    }
    if (part.type === 'dynamic-tool') {
      chunks.push({
        type: 'tool-input-available',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        dynamic: true,
        input: part.input,
      })
      if (part.state === 'output-available') {
        chunks.push({
          type: 'tool-output-available',
          toolCallId: part.toolCallId,
          dynamic: true,
          output: part.output,
        })
      } else if (part.state === 'output-error') {
        chunks.push({
          type: 'tool-output-error',
          toolCallId: part.toolCallId,
          dynamic: true,
          errorText: part.errorText,
        })
      }
      continue
    }
    if (part.type === 'data-plan') {
      chunks.push({ type: 'data-plan', id: part.id, data: part.data })
      continue
    }
    if (part.type === 'data-validation') {
      chunks.push({ type: 'data-validation', id: part.id, data: part.data })
    }
  }
  return chunks
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export class UIMessageEmitter {
  private textSeq = 0
  private activeTextId: string | null = null
  private toolSeq = 0
  private readonly knownTools = new Set<string>()

  constructor(
    readonly runId: string,
    private readonly write: (chunk: AppUIMessageChunk) => void,
  ) {}

  start() {
    this.write({ type: 'start', messageId: assistantId(this.runId) })
    this.write({
      type: 'data-run-started',
      id: `run:${this.runId}`,
      transient: true,
      data: { runId: this.runId, status: 'running' },
    })
  }

  emit(type: string, payload: Record<string, unknown> = {}): boolean {
    if (type === 'text-delta') {
      const delta = stringValue(payload.text)
      if (!delta) return false
      if (!this.activeTextId) {
        this.activeTextId = `text:${++this.textSeq}`
        this.write({ type: 'text-start', id: this.activeTextId })
      }
      this.write({ type: 'text-delta', id: this.activeTextId, delta })
      return true
    }

    if (type === 'plan-updated') {
      this.closeText()
      const revision = Number(payload.revision)
      const steps = Array.isArray(payload.steps) ? (payload.steps as PlanStep[]) : []
      if (!Number.isInteger(revision) || revision < 1 || !steps.length) return false
      this.write({
        type: 'data-plan',
        id: `plan:${revision}`,
        data: {
          revision,
          steps: steps.slice(0, 8).map((step) => ({
            id: String(step.id).slice(0, 64),
            title: String(step.title).slice(0, 200),
            status: step.status,
          })),
        },
      })
      return true
    }

    if (type === 'validation-status') {
      this.closeText()
      const status = payload.status
      if (!['running', 'passed', 'failed', 'skipped'].includes(String(status))) return false
      const attempt =
        Number.isInteger(payload.attempt) && Number(payload.attempt) > 0 ? Number(payload.attempt) : 1
      const check = stringValue(payload.check).slice(0, 64) || undefined
      const message = stringValue(payload.message).slice(0, 500) || undefined
      this.write({
        type: 'data-validation',
        id: `validation:${attempt}:${check ?? 'run'}`,
        data: {
          attempt,
          ...(check ? { check } : {}),
          status: status as ValidationData['status'],
          ...(message ? { message } : {}),
        },
      })
      return true
    }

    if (type === 'tool-started') {
      this.closeText()
      const toolName = stringValue(payload.tool).slice(0, 64)
      if (!toolName || toolName === 'update_plan') return false
      const toolCallId = stringValue(payload.toolCallId).slice(0, 256) || `tool:${++this.toolSeq}`
      this.knownTools.add(toolCallId)
      this.write({
        type: 'tool-input-available',
        toolCallId,
        toolName,
        dynamic: true,
        input: record(payload.input),
      })
      return true
    }

    if (type === 'tool-finished') {
      this.closeText()
      const toolName = stringValue(payload.tool).slice(0, 64)
      if (!toolName || toolName === 'update_plan') return false
      const toolCallId = stringValue(payload.toolCallId).slice(0, 256) || `tool:${++this.toolSeq}`
      if (!this.knownTools.has(toolCallId)) {
        this.knownTools.add(toolCallId)
        this.write({
          type: 'tool-input-available',
          toolCallId,
          toolName,
          dynamic: true,
          input: record(payload.input),
        })
      }
      const error = stringValue(payload.error).slice(0, 500)
      if (error || payload.ok === false) {
        this.write({
          type: 'tool-output-error',
          toolCallId,
          dynamic: true,
          errorText: error || '工具执行失败',
        })
      } else {
        this.write({
          type: 'tool-output-available',
          toolCallId,
          dynamic: true,
          output: record(payload.result),
        })
      }
      return true
    }

    if (type === 'model-status') {
      this.write({
        type: 'data-model',
        id: `model:${stringValue(payload.step) || 'run'}`,
        transient: true,
        data: payload,
      })
      return false
    }

    if (type === 'phase') {
      this.write({
        type: 'data-phase',
        id: 'phase',
        transient: true,
        data: { runId: this.runId, phase: stringValue(payload.phase) },
      })
      return false
    }

    if (type === 'preview-status') {
      this.write({
        type: 'data-preview',
        id: 'preview',
        transient: true,
        data: payload,
      })
      return false
    }

    return false
  }

  closeText() {
    if (!this.activeTextId) return
    this.write({ type: 'text-end', id: this.activeTextId })
    this.activeTextId = null
  }

  finish(payload: Record<string, unknown>) {
    this.closeText()
    this.write({
      type: 'data-run',
      id: `run:${this.runId}`,
      transient: true,
      data: { runId: this.runId, ...payload },
    })
    this.write({ type: 'finish' })
  }
}

export class UIMessageAccumulator {
  private readonly writer: WritableStreamDefaultWriter<AppUIMessageChunk>
  private readonly stream: ReadableStream<AppUIMessageChunk>
  private readonly done: Promise<void>
  private message: AppUIMessage
  private chain: Promise<void> = Promise.resolve()

  constructor(runId: string) {
    this.message = assistantMessage(runId)
    const pair = new TransformStream<AppUIMessageChunk, AppUIMessageChunk>()
    this.writer = pair.writable.getWriter()
    this.stream = pair.readable
    this.done = (async () => {
      try {
        for await (const message of readUIMessageStream<AppUIMessage>({
          message: this.message,
          stream: this.stream,
        })) {
          this.message = message
        }
      } catch {
        // 保持最后一份完整快照
      }
    })()
  }

  write(chunk: AppUIMessageChunk) {
    this.chain = this.chain.then(() => this.writer.write(chunk)).catch(() => undefined)
  }

  async snapshot(): Promise<AppUIMessage> {
    await this.chain
    await new Promise<void>((resolve) => setImmediate(resolve))
    return structuredClone(this.message)
  }

  async close(): Promise<AppUIMessage> {
    await this.chain
    await this.writer.close().catch(() => undefined)
    await this.done
    return structuredClone(this.message)
  }
}
