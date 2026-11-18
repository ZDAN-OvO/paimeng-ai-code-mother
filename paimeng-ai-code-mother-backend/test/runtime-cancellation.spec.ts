import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { DockerService, type DockerResult } from '../src/runtime/docker.service'
import { RuntimeService } from '../src/runtime/runtime.service'
import { useTempDirs } from './support/temp-dir'

const tempDir = useTempDirs()

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
  const root = await tempDir('paimeng-cancel-')
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
