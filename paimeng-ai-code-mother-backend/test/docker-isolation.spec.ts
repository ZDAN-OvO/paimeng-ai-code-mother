import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { DockerService } from '../src/runtime/docker.service'

interface FakeResult {
  code: number
  stdout: string
  stderr?: string
}

function createService(handler: (args: string[]) => FakeResult) {
  const service = new DockerService({} as AppConfigService)
  const calls: string[][] = []
  service.run = async (args) => {
    calls.push(args)
    const result = handler(args)
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      timedOut: false,
    }
  }
  return { service, calls }
}

function networkInspect(network: { Internal: boolean; Options?: Record<string, string> }) {
  return JSON.stringify([{ Id: 'network-id', Driver: 'bridge', ...network }])
}

function containerInspect(labels: Record<string, string>) {
  return JSON.stringify({
    Id: 'container-id',
    State: { Running: true, Status: 'running', ExitCode: 0 },
    Config: { Labels: labels },
    NetworkSettings: { Networks: {} },
  })
}

describe('docker network isolation', () => {
  it('rejects an existing non-internal network', async () => {
    const { service } = createService(() => ({
      code: 0,
      stdout: networkInspect({ Internal: false }),
    }))

    await expect(service.ensureNetwork('paimeng-apps', true)).rejects.toThrow('不是 internal')
  })

  it('rejects an internal network that still allows inter-container traffic', async () => {
    const { service } = createService(() => ({
      code: 0,
      stdout: networkInspect({ Internal: true, Options: {} }),
    }))

    await expect(service.ensureNetwork('paimeng-apps', true)).rejects.toThrow('未关闭容器间通信')
  })

  it('reuses an existing internal network with ICC disabled', async () => {
    const { service, calls } = createService(() => ({
      code: 0,
      stdout: networkInspect({
        Internal: true,
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      }),
    }))

    await expect(service.ensureNetwork('paimeng-apps', true)).resolves.toBeUndefined()
    expect(calls.some((args) => args[0] === 'network' && args[1] === 'create')).toBe(false)
  })
})

describe('docker container ownership', () => {
  it('removes a container that carries the project label', async () => {
    const { service, calls } = createService(() => ({
      code: 0,
      stdout: containerInspect({ 'paimeng.project': 'paimeng-ai-code-mother' }),
    }))

    await expect(service.removeContainer('paimeng-app-1')).resolves.toBe(true)
    expect(calls.some((args) => args[0] === 'rm' && args[1] === '-f')).toBe(true)
  })

  it('refuses to remove a container owned by another project', async () => {
    const { service, calls } = createService(() => ({
      code: 0,
      stdout: containerInspect({ 'com.docker.compose.project': 'other' }),
    }))

    await expect(service.removeContainer('paimeng-app-1')).resolves.toBe(false)
    expect(calls.some((args) => args[0] === 'rm')).toBe(false)
  })

  it('refuses to stop a container owned by another project', async () => {
    const { service, calls } = createService(() => ({
      code: 0,
      stdout: containerInspect({ 'com.docker.compose.project': 'other' }),
    }))

    await expect(service.stopContainer('paimeng-app-1')).resolves.toBe(false)
    expect(calls.some((args) => args[0] === 'stop')).toBe(false)
  })
})
