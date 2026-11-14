import { Injectable, Logger } from '@nestjs/common'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppConfigService } from '../config/config.module'

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface DockerRunOptions {
  timeoutMs?: number
  maxOutputBytes?: number
}

interface DockerContainerInspect {
  Id: string
  State: { Running: boolean; Status: string; ExitCode: number }
  Config?: { Labels?: Record<string, string> }
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }
}

interface DockerNetworkInspect {
  Id?: string
  Driver?: string
  Internal?: boolean
  Options?: Record<string, string>
}

const PROJECT_LABEL = 'paimeng.project'
const PROJECT_NAME = 'paimeng-ai-code-mother'
const ICC_OPTION = 'com.docker.network.bridge.enable_icc'

@Injectable()
export class DockerService {
  private readonly logger = new Logger(DockerService.name)
  private imageReady: Promise<string> | null = null

  constructor(private readonly config: AppConfigService) {}

  get projectLabel() {
    return PROJECT_LABEL
  }
  get projectName() {
    return PROJECT_NAME
  }

  private dockerPath = process.env.DOCKER_BIN || 'docker'

  async run(args: string[], options: DockerRunOptions = {}): Promise<DockerResult> {
    const timeoutMs = options.timeoutMs ?? 60_000
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    return new Promise((resolvePromise) => {
      const child = spawn(this.dockerPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let killedForSize = false
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString('utf8')
        if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
          killedForSize = true
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          return next.slice(-maxOutputBytes)
        }
        return next
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolvePromise({ code: code ?? -1, stdout, stderr, timedOut })
      })
      if (killedForSize) this.logger.warn(`docker 输出超过 ${maxOutputBytes} 字节，已截断`)
    })
  }


  async containerRunning(name: string) {
    const result = await this.inspectContainer(name)
    return result?.State?.Running === true
  }

  async inspectContainer(name: string) {
    const res = await this.run(['inspect', name, '--format', '{{json .}}'], { timeoutMs: 15_000 })
    if (res.code !== 0) return null
    try {
      return JSON.parse(res.stdout.trim()) as DockerContainerInspect
    } catch {
      return null
    }
  }

  private isProjectContainer(info: DockerContainerInspect) {
    return info.Config?.Labels?.[PROJECT_LABEL] === PROJECT_NAME
  }

  async inspectNetwork(name: string) {
    const res = await this.run(['network', 'inspect', name], { timeoutMs: 15_000 })
    if (res.code !== 0) return null
    try {
      return (JSON.parse(res.stdout) as DockerNetworkInspect[])[0] ?? null
    } catch {
      return null
    }
  }

  async networkExists(name: string) {
    const res = await this.run(['network', 'inspect', name, '--format', '{{.Id}}'], { timeoutMs: 15_000 })
    return res.code === 0
  }

  async ensureNetwork(name: string, internal: boolean) {
    const existing = await this.inspectNetwork(name)
    if (existing) {
      if (internal) {
        if (existing.Internal !== true) {
          throw new Error(`Docker 网络 ${name} 已存在但不是 internal，拒绝使用`)
        }
        if (existing.Options?.[ICC_OPTION] !== 'false') {
          throw new Error(`Docker 网络 ${name} 未关闭容器间通信（${ICC_OPTION}=false），拒绝使用`)
        }
      }
      return
    }
    const args = ['network', 'create']
    if (internal) args.push('--internal', '--opt', `${ICC_OPTION}=false`)
    args.push(name)
    const res = await this.run(args, { timeoutMs: 30_000 })
    if (res.code !== 0) throw new Error(`创建 Docker 网络 ${name} 失败: ${res.stderr || res.stdout}`)
  }

  async networkGateway(name: string): Promise<string> {
    const res = await this.run(['network', 'inspect', name], { timeoutMs: 15_000 })
    if (res.code !== 0) throw new Error(`无法读取 Docker 网络 ${name}`)
    const parsed = JSON.parse(res.stdout) as Array<{ IPAM?: { Config?: Array<{ Gateway?: string }> } }>
    const gateway = parsed[0]?.IPAM?.Config?.[0]?.Gateway
    if (!gateway) throw new Error(`Docker 网络 ${name} 没有网关地址`)
    return gateway
  }

  async listProjectContainers(): Promise<Array<{ ID: string; Names: string; State: string; Labels: string }>> {
    const res = await this.run(
      ['ps', '-a', '--filter', `label=${PROJECT_LABEL}=${PROJECT_NAME}`, '--format', '{{json .}}'],
      { timeoutMs: 15_000 },
    )
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { ID: string; Names: string; State: string; Labels: string }]
        } catch {
          return []
        }
      })
  }

  async listAppContainers(appId: number) {
    const all = await this.listProjectContainers()
    return all.filter((c) => c.Labels.includes(`paimeng.app=${appId}`))
  }

  async removeContainer(nameOrId: string) {
    const info = await this.inspectContainer(nameOrId)
    if (!info) return false
    if (!this.isProjectContainer(info)) {
      this.logger.warn(`拒绝删除非本项目容器 ${nameOrId}`)
      return false
    }
    const res = await this.run(['rm', '-f', nameOrId], { timeoutMs: 30_000 })
    return res.code === 0
  }

  async stopContainer(nameOrId: string) {
    const info = await this.inspectContainer(nameOrId)
    if (!info) return false
    if (!this.isProjectContainer(info)) {
      this.logger.warn(`拒绝停止非本项目容器 ${nameOrId}`)
      return false
    }
    const res = await this.run(['stop', '-t', '5', nameOrId], { timeoutMs: 20_000 })
    return res.code === 0
  }

  runtimeImageHash(): string {
    const files = [
      resolve(__dirname, '../../../docker/runtime/Dockerfile'),
      resolve(__dirname, '../../../docker/runtime/vite.config.platform.ts'),
    ]
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(existsSync(file) ? readFileSync(file) : 'missing')
    }
    hash.update(process.env.PAIMENG_RUNTIME_IMAGE_SEED ?? '')
    return hash.digest('hex').slice(0, 12)
  }

  async ensureRuntimeImage(): Promise<string> {
    if (this.imageReady) return this.imageReady
    this.imageReady = this.buildRuntimeImage()
    try {
      return await this.imageReady
    } catch (err) {
      this.imageReady = null
      throw err
    }
  }

  private async buildRuntimeImage(): Promise<string> {
    const hash = this.runtimeImageHash()
    const image = `${this.config.runtimeImage}:${hash}`
    const inspect = await this.run(['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 })
    if (inspect.code === 0) return image
    if (!this.config.setupImageOnStart) {
      throw new Error(`运行时镜像 ${image} 不存在，请先启动后端（SETUP_IMAGE_ON_START=true）或运行 docker build`)
    }
    const context = resolve(__dirname, '../../../docker/runtime')
    this.logger.log(`构建运行时镜像 ${image}`)
    const res = await this.run(['build', '-t', image, context], { timeoutMs: 300_000, maxOutputBytes: 2 * 1024 * 1024 })
    if (res.code !== 0) throw new Error(`构建运行时镜像失败: ${(res.stderr || res.stdout).slice(-4000)}`)
    return image
  }

  async runDetached(args: string[]): Promise<{ id: string }> {
    const res = await this.run(args, { timeoutMs: 30_000 })
    if (res.code !== 0) throw new Error(res.stderr || res.stdout || 'docker run 失败')
    return { id: res.stdout.trim() }
  }

  async containerLogs(container: string, tail = 200): Promise<string> {
    const res = await this.run(['logs', '--tail', String(tail), container], { timeoutMs: 15_000 })
    return `${res.stdout}\n${res.stderr}`.trim()
  }

  async containerIp(container: string, network: string): Promise<string | null> {
    const info = await this.inspectContainer(container)
    return info?.NetworkSettings.Networks[network]?.IPAddress || null
  }

  hostMemoryAvailableBytes(): number {
    try {
      const text = readFileSync('/proc/meminfo', 'utf8')
      const match = /MemAvailable:\s+(\d+)\s+kB/.exec(text)
      return match ? Number(match[1]) * 1024 : 0
    } catch {
      return 0
    }
  }

  hostDiskFreeBytes(path: string): number {
    try {
      const out = spawnSync('df', ['-B1', '--output=avail', path], { encoding: 'utf8' })
      const line = out.stdout.split('\n')[1]
      return Number(line?.trim() ?? 0)
    } catch {
      return 0
    }
  }
}
