import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { AgentService, type AgentRunInput } from '../src/agent/agent.service'
import type { ToolContext } from '../src/runtime/file-service'

vi.mock('ai', async (original) => ({ ...(await original<object>()), streamText: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function respond(parts: unknown[], finishReason = 'stop') {
  vi.mocked(streamText).mockReturnValueOnce({
    fullStream: (async function* () {
      for (const part of parts) yield part
      yield { type: 'finish', finishReason, totalUsage: { inputTokens: 10, outputTokens: 20 } }
    })(),
  } as never)
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'paimeng-output-'))
  roots.push(root)
  const store = {
    list: vi.fn().mockResolvedValue([]),
    toModelMessages: vi.fn().mockReturnValue([]),
    append: vi.fn().mockResolvedValue(undefined),
  }
  const tools = {
    definitionsForModel: () => ({}),
    modelToolSchemas: () => ({}),
    execute: vi.fn(async (ctx: ToolContext, name: string) => {
      if (name === 'write') {
        await writeFile(join(root, 'index.html'), '<h1>ok</h1>')
        ctx.markMutated?.()
      }
      return '{}'
    }),
  }
  const runtime = {
    detectProject: vi.fn().mockResolvedValue({ hasPackageJson: false, kind: 'static' }),
    sourceStats: vi.fn().mockResolvedValue({ files: 1 }),
    cleanupBuildDeps: vi.fn().mockResolvedValue(undefined),
  }
  const preview = { markChanged: vi.fn(), stopForStatic: vi.fn().mockResolvedValue(undefined) }
  const details = { recordValidationLog: vi.fn().mockResolvedValue(undefined) }
  const config = {
    aiBaseUrl: 'http://test.invalid/v1',
    aiApiKey: 'test',
    aiModel: 'test',
    aiOutputReserveTokens: 8192,
    aiContextWindowTokens: 1_000_000,
    toolOutputMaxBytes: 51200,
    modelTimeoutMs: 10_000,
    runMaxSteps: 100,
    runMaxDurationMs: 30_000,
    appSourceDir: () => root,
    previewUrl: () => 'http://preview.invalid',
  }
  const service = new AgentService(
    config as never,
    store as never,
    tools as never,
    { list: vi.fn().mockResolvedValue([]) } as never,
    runtime as never,
    preview as never,
    details as never,
  )
  const controller = new AbortController()
  const input: AgentRunInput = {
    runId: 'run',
    appId: 1,
    conversationId: 1,
    deadlineAt: new Date(Date.now() + 30_000),
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
    emit: vi.fn(),
    setPhase: vi.fn(),
  }
  return { service, input, tools, store, runtime, controller }
}

describe('agent model output boundaries', () => {
  it('retains already streamed text when the user interrupts a model request', async () => {
    const { service, input, controller } = await setup()
    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '已完成目录检查' }
        controller.abort()
        yield { type: 'abort' }
      })(),
    } as never)
    expect(await service.execute(input)).toMatchObject({ status: 'cancelled', text: '已完成目录检查' })
  })

  it('retains already streamed text when the gateway fails', async () => {
    const { service, input } = await setup()
    respond([
      { type: 'text-delta', text: '已开始实现' },
      { type: 'error', error: new Error('broken') },
    ])
    expect(await service.execute(input)).toMatchObject({
      status: 'failed',
      text: '已开始实现',
      errorCode: 'MODEL_ERROR',
    })
  })

  it('does not reset the recovery limit when read-only tools appear between failures', async () => {
    const { service, input, tools } = await setup()
    for (let index = 0; index < 3; index += 1) {
      respond(
        [{ type: 'tool-call', toolCallId: `bad-${index}`, toolName: 'write', input: '{', invalid: true }],
        'length',
      )
      if (index < 2)
        respond([{ type: 'tool-call', toolCallId: `ls-${index}`, toolName: 'ls', input: {} }], 'tool-calls')
    }
    expect(await service.execute(input)).toMatchObject({ errorCode: 'MODEL_OUTPUT_LIMIT', stepCount: 5 })
    expect(tools.execute.mock.calls.map((args) => args[1])).toEqual(['ls', 'ls'])
  })

  it('aborts the upstream request when a stream error arrives before the connection closes', async () => {
    const { service, input } = await setup()
    let upstreamSignal: AbortSignal | undefined
    vi.mocked(streamText).mockImplementationOnce((settings) => {
      upstreamSignal = settings.abortSignal
      return {
        fullStream: (async function* () {
          yield { type: 'error', error: new Error('gateway failed') }
          await new Promise(() => undefined)
        })(),
      } as never
    })
    expect(await service.execute(input)).toMatchObject({ errorCode: 'MODEL_ERROR' })
    expect(upstreamSignal?.aborted).toBe(true)
  })

  it('never executes truncated calls and stops after three attempts without validating', async () => {
    const { service, input, tools, store, runtime } = await setup()
    for (let index = 0; index < 3; index += 1) {
      respond(
        [
          {
            type: 'tool-call',
            toolCallId: `call-${index}`,
            toolName: 'write',
            input: '{"content":"cut',
            invalid: true,
          },
        ],
        'length',
      )
    }
    const outcome = await service.execute(input)
    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_OUTPUT_LIMIT',
      stepCount: 3,
      repairCount: 0,
    })
    expect(tools.execute).not.toHaveBeenCalled()
    expect(runtime.sourceStats).not.toHaveBeenCalled()
    const results = store.append.mock.calls.filter((args) => args[2] === 'tool')
    expect(results).toHaveLength(3)
    expect(JSON.stringify(results)).toContain('截断')
    expect(JSON.stringify(store.append.mock.calls)).toContain('不要重发相同的大文件')
  })

  it('allows a complete small write after a truncated call, then validates', async () => {
    const { service, input, tools } = await setup()
    respond(
      [{ type: 'tool-call', toolCallId: 'cut', toolName: 'write', input: '{', invalid: true }],
      'length',
    )
    respond(
      [
        {
          type: 'tool-call',
          toolCallId: 'ok',
          toolName: 'write',
          input: { path: 'index.html', content: 'ok' },
        },
      ],
      'tool-calls',
    )
    respond([{ type: 'text-delta', text: '完成' }])
    expect(await service.execute(input)).toMatchObject({ status: 'completed', repairCount: 0 })
    expect(tools.execute).toHaveBeenCalledTimes(1)
    expect(input.emit).toHaveBeenCalledWith(
      'validation-status',
      expect.objectContaining({ status: 'passed' }),
    )
  })

  it('treats stream errors as model failures instead of no-code retries', async () => {
    const { service, input, store } = await setup()
    respond([{ type: 'error', error: new Error('gateway connection reset') }])
    expect(await service.execute(input)).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_ERROR',
      stepCount: 0,
    })
    expect(streamText).toHaveBeenCalledTimes(1)
    expect(store.append).not.toHaveBeenCalled()
  })

  it('keeps user cancellation distinct from model failure', async () => {
    const { service, input, controller } = await setup()
    vi.mocked(streamText).mockImplementationOnce(() => {
      controller.abort()
      return {
        fullStream: (async function* () {
          yield { type: 'abort' }
        })(),
      } as never
    })
    expect(await service.execute(input)).toMatchObject({ status: 'cancelled', repairCount: 0 })
  })
})
