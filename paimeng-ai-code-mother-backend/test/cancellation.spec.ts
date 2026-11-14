import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { DockerService, type DockerResult } from '../src/runtime/docker.service'
import { FileService, type ToolContext } from '../src/runtime/file-service'
import { RuntimeService } from '../src/runtime/runtime.service'
import { RunsController } from '../src/runs/runs.controller'
import { RunStream } from '../src/runs/run-stream'

const TIMEOUT_MS = 5000

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待测试条件超时')
}

class FakeDocker {
  readonly projectLabel = 'paimeng.project'
  readonly projectName = 'paimeng-test'
  readonly started: string[] = []
  readonly removed: string[] = []
  readonly pendingWaits = new Set<string>()
  detachedStarted = false
  private readonly waiters = new Map<string, (code: number) => void>()

  async run(args: string[]): Promise<DockerResult> {
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]
      this.started.push(name)
      return { code: 0, stdout: `id-${name}`, stderr: '', timedOut: false }
    }
    if (args[0] === 'wait') {
      const name = args[1]
      this.pendingWaits.add(name)
      return new Promise<DockerResult>((resolve) => {
        this.waiters.set(name, (code) => {
          this.pendingWaits.delete(name)
          resolve({ code, stdout: String(code), stderr: '', timedOut: false })
        })
      })
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }

  async removeContainer(name: string) {
    this.removed.push(name)
    this.waiters.get(name)?.(137)
  }

  async runDetached() {
    this.detachedStarted = true
    return { id: 'preview-container' }
  }

  async inspectContainer() {
    return {
      Id: 'preview-container',
      State: { Running: true, Status: 'running', ExitCode: 0 },
      NetworkSettings: { Networks: { 'paimeng-apps': { IPAddress: '192.0.2.10' } } },
    }
  }

  async containerRunning() {
    return false
  }

  async containerLogs() {
    return ''
  }

  async ensureRuntimeImage() {
    return 'paimeng-runtime:test'
  }

  async listProjectContainers() {
    return []
  }

  hostMemoryAvailableBytes() {
    return 16 * 1024 * 1024 * 1024
  }

  hostDiskFreeBytes() {
    return 100 * 1024 * 1024 * 1024
  }
}

function runtimeConfig(root: string) {
  return {
    appSourceDir: (appId: number) => join(root, 'source', String(appId)),
    appDepsDir: (appId: number) => join(root, 'deps', String(appId)),
    appBuildDir: (appId: number) => join(root, 'build', String(appId)),
    taskLogRoot: join(root, 'logs'),
    installNetwork: 'paimeng-install-test',
    appNetwork: 'paimeng-apps',
    previewPort: 3000,
    previewScheme: 'http',
    installTimeoutMs: 300_000,
    buildTimeoutMs: 180_000,
    previewStartTimeoutMs: 60_000,
    taskMemoryBytes: 1536 * 1024 * 1024,
    memoryTotalBudgetBytes: 8 * 1024 * 1024 * 1024,
    memoryHostReserveBytes: 2 * 1024 * 1024 * 1024,
    diskReserveBytes: 2 * 1024 * 1024 * 1024,
    taskMemoryDocker: '1536m',
  } as unknown as AppConfigService
}

async function setupRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'paimeng-cancel-'))
  const docker = new FakeDocker()
  const runtime = new RuntimeService(
    runtimeConfig(root),
    docker as unknown as DockerService,
    {
      url: 'http://127.0.0.1:4873',
      error: null,
    } as never,
  )
  runtime.isPortOpen = async () => false
  return { root, docker, runtime }
}

async function setupFiles() {
  const root = await mkdtemp(join(tmpdir(), 'paimeng-cancel-files-'))
  const files = new FileService({
    appSourceDir: (appId: number) => join(root, String(appId)),
    maxFileBytes: 1024 * 1024,
    maxSourceBytes: 100 * 1024 * 1024,
    maxFileCount: 5000,
  } as unknown as AppConfigService)
  await mkdir(join(root, '1'), { recursive: true })
  return { root, files }
}

function toolContext(isCancelled: () => boolean): ToolContext {
  return {
    appId: 1,
    runId: 'run',
    isCancelled,
    readVersions: new Map(),
    markPreviewChanged: () => undefined,
    emit: () => undefined,
  }
}

describe('file tool cancellation', () => {
  it('does not write when cancellation is already requested', async () => {
    const { root, files } = await setupFiles()
    await expect(
      files.write(
        toolContext(() => true),
        'index.html',
        '<h1>x</h1>',
      ),
    ).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(false)
  })

  it('removes the staged temp file when cancellation arrives during write', async () => {
    const { root, files } = await setupFiles()
    let checks = 0
    const ctx = toolContext(() => {
      checks += 1
      return checks >= 2
    })
    await expect(files.write(ctx, 'index.html', '<h1>x</h1>')).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(false)
    expect(existsSync(join(root, '1'))).toBe(true)
  })

  it('leaves the original file unchanged when cancellation arrives during edit', async () => {
    const { root, files } = await setupFiles()
    await writeFile(join(root, '1/index.html'), '<h1>old</h1>')
    let checks = 0
    const ctx = toolContext(() => {
      checks += 1
      return checks >= 2
    })
    await files.read(ctx, 'index.html')
    await expect(files.edit(ctx, 'index.html', [{ oldText: 'old', newText: 'new' }])).rejects.toThrow(
      '任务已取消',
    )
    expect(await readFile(join(root, '1/index.html'), 'utf8')).toBe('<h1>old</h1>')
  })

  it('does not delete when cancellation is already requested', async () => {
    const { root, files } = await setupFiles()
    await writeFile(join(root, '1/index.html'), '<h1>x</h1>')
    await expect(
      files.delete(
        toolContext(() => true),
        'index.html',
      ),
    ).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(true)
  })
})

describe('runtime stage cancellation', () => {
  it('stops an install container within five seconds of cancellation', async () => {
    const { root, docker, runtime } = await setupRuntime()
    await mkdir(join(root, 'source/1'), { recursive: true })
    await writeFile(join(root, 'source/1/package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    const controller = new AbortController()
    const started = Date.now()
    const resultPromise = runtime.ensureDependencies(1, () => controller.signal.aborted)
    await waitFor(() => docker.pendingWaits.has('paimeng-install-1'))
    controller.abort()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toBe('任务已取消')
    expect(docker.removed).toContain('paimeng-install-1')
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS)
  })

  it('stops a build container within five seconds of cancellation', async () => {
    const { root, docker, runtime } = await setupRuntime()
    await mkdir(join(root, 'source/1'), { recursive: true })
    await mkdir(join(root, 'deps/1/node_modules'), { recursive: true })
    await writeFile(
      join(root, 'source/1/package.json'),
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^7.0.0' },
      }),
    )
    const controller = new AbortController()
    const started = Date.now()
    const resultPromise = runtime.build(1, () => controller.signal.aborted)
    await waitFor(() => docker.pendingWaits.has('paimeng-build-1'))
    controller.abort()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toBe('任务已取消')
    expect(docker.removed).toContain('paimeng-build-1')
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS)
  })

  it('stops preview startup and removes its container within five seconds', async () => {
    const { root, docker, runtime } = await setupRuntime()
    await mkdir(join(root, 'source/1'), { recursive: true })
    await mkdir(join(root, 'deps/1/node_modules/vite'), { recursive: true })
    const controller = new AbortController()
    const started = Date.now()
    const resultPromise = runtime.startPreviewContainer(1, () => controller.signal.aborted)
    await waitFor(() => docker.detachedStarted)
    controller.abort()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toBe('任务已取消')
    expect(docker.removed).toContain('paimeng-app-1')
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS)
  })
})

class FakeResponse extends EventEmitter {
  writableEnded = false
  status() {
    return this
  }
  setHeader() {
    return this
  }
  flushHeaders() {
    return undefined
  }
  write() {
    return true
  }
  end() {
    this.writableEnded = true
  }
}

describe('SSE disconnect handling', () => {
  it('cancels the run when the stream disconnects before the final event', async () => {
    const stream = new RunStream('run-disconnect')
    let cancelled = 0
    const runs = {
      startRun: async () => ({ runId: stream.runId, reused: false }),
      getStream: () => stream,
      latestFinishedEvent: async () => null,
      cancelRun: async () => {
        cancelled += 1
        return { runId: stream.runId, status: 'cancelling' }
      },
    }
    const controller = new RunsController(runs as never, {} as never)
    const response = new FakeResponse()
    await controller.chat(
      { appId: 1, message: '生成页面', clientRequestId: 'request-0001' } as never,
      1,
      {} as never,
      response as never,
    )

    response.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(1)
  })

  it('does not cancel after a normal run-finished close', async () => {
    const stream = new RunStream('run-finished')
    let cancelled = 0
    const runs = {
      startRun: async () => ({ runId: stream.runId, reused: false }),
      getStream: () => stream,
      latestFinishedEvent: async () => null,
      cancelRun: async () => {
        cancelled += 1
        return { runId: stream.runId, status: 'cancelling' }
      },
    }
    const controller = new RunsController(runs as never, {} as never)
    const response = new FakeResponse()
    await controller.chat(
      { appId: 1, message: '生成页面', clientRequestId: 'request-0002' } as never,
      1,
      {} as never,
      response as never,
    )

    stream.emit({
      type: 'data-run',
      id: `run:${stream.runId}`,
      transient: true,
      data: { runId: stream.runId, status: 'completed' },
    })
    stream.finish()
    response.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(0)
    expect(response.writableEnded).toBe(true)
  })
})
