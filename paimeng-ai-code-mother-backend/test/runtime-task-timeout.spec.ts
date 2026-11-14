import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { DockerService } from '../src/runtime/docker.service'
import { RuntimeService } from '../src/runtime/runtime.service'

function config(root: string, previewStartTimeoutMs = 60_000) {
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
    buildTimeoutMs: 80,
    previewStartTimeoutMs,
    taskMemoryBytes: 1536 * 1024 * 1024,
    memoryTotalBudgetBytes: 8 * 1024 * 1024 * 1024,
    memoryHostReserveBytes: 2 * 1024 * 1024 * 1024,
    diskReserveBytes: 2 * 1024 * 1024 * 1024,
    taskMemoryDocker: '1536m',
  } as unknown as AppConfigService
}

describe('runtime task timeout', () => {
  it('kills a hanging build wait and removes the task container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paimeng-task-timeout-'))
    await mkdir(join(root, 'source/1'), { recursive: true })
    await mkdir(join(root, 'deps/1/node_modules'), { recursive: true })
    await writeFile(
      join(root, 'source/1/package.json'),
      JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^7.0.0' } }),
    )
    const log = join(root, 'docker.log')
    const script = join(root, 'fake-docker.sh')
    await writeFile(
      script,
      `#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
if [ "$1" = "wait" ]; then exec sleep 10; fi
if [ "$1" = "run" ]; then echo fake-container-id; exit 0; fi
exit 0
`,
    )
    await chmod(script, 0o755)

    const previousBin = process.env.DOCKER_BIN
    const previousLog = process.env.DOCKER_LOG
    process.env.DOCKER_BIN = script
    process.env.DOCKER_LOG = log
    try {
      const runtime = new RuntimeService(
        config(root),
        new DockerService(config(root)),
        { url: 'http://127.0.0.1:4873', error: null } as never,
      )
      const started = Date.now()
      const result = await runtime.build(1)
      expect(result.ok).toBe(false)
      expect(result.timedOut).toBe(true)
      expect(result.error).toContain('构建超时')
      expect(Date.now() - started).toBeLessThan(3000)
      expect(await readFile(log, 'utf8')).toContain('rm -f paimeng-build-1')
    } finally {
      if (previousBin === undefined) delete process.env.DOCKER_BIN
      else process.env.DOCKER_BIN = previousBin
      if (previousLog === undefined) delete process.env.DOCKER_LOG
      else process.env.DOCKER_LOG = previousLog
    }
  })

  it('removes the preview container when startup exceeds the deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paimeng-preview-timeout-'))
    await mkdir(join(root, 'source/1'), { recursive: true })
    await mkdir(join(root, 'deps/1/node_modules/vite'), { recursive: true })
    const removed: string[] = []
    const docker = {
      projectLabel: 'paimeng.project',
      projectName: 'paimeng-test',
      runDetached: async () => ({ id: 'preview-container' }),
      inspectContainer: async () => ({
        State: { Running: true, Status: 'running', ExitCode: 0 },
        NetworkSettings: { Networks: { 'paimeng-apps': { IPAddress: '192.0.2.10' } } },
      }),
      removeContainer: async (name: string) => {
        removed.push(name)
      },
      containerLogs: async () => '',
      ensureRuntimeImage: async () => 'paimeng-runtime:test',
      listProjectContainers: async () => [],
      hostMemoryAvailableBytes: () => 16 * 1024 * 1024 * 1024,
      hostDiskFreeBytes: () => 100 * 1024 * 1024 * 1024,
    }
    const runtime = new RuntimeService(
      config(root, 80),
      docker as unknown as DockerService,
      { url: 'http://127.0.0.1:4873', error: null } as never,
    )
    runtime.isPortOpen = async () => false

    const started = Date.now()
    const result = await runtime.startPreviewContainer(1)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('预览启动超时')
    expect(removed).toContain('paimeng-app-1')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
