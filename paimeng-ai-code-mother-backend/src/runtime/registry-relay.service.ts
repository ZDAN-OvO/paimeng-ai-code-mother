import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { AppConfigService } from '../config/config.module'
import { DockerService } from './docker.service'

const MAX_METADATA_BYTES = 64 * 1024 * 1024
const MAX_TARBALL_BYTES = 100 * 1024 * 1024

@Injectable()
export class RegistryRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryRelayService.name)
  private server: Server | null = null
  private gatewayIp: string | null = null
  private ready = false
  private lastError: string | null = null

  constructor(
    private readonly config: AppConfigService,
    private readonly docker: DockerService,
  ) {}

  get url(): string | null {
    if (!this.gatewayIp) return null
    return `http://${this.gatewayIp}:${this.config.registryRelayPort}/`
  }

  get isReady() {
    return this.ready
  }

  get error() {
    return this.lastError
  }

  async onModuleInit() {
    try {
      await this.docker.ensureNetwork(this.config.installNetwork, true)
      this.gatewayIp = await this.docker.networkGateway(this.config.installNetwork)
      await this.listen(this.gatewayIp)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.logger.warn(`npm 中继未启动: ${this.lastError}`)
    }
  }

  private listen(host: string) {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`relay error: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      server.on('error', (err) => {
        this.lastError = err.message
        reject(err)
      })
      server.listen(this.config.registryRelayPort, host, () => {
        this.server = server
        this.ready = true
        this.lastError = null
        this.logger.log(`npm 受限中继监听 ${host}:${this.config.registryRelayPort}`)
        resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end('method not allowed')
      return
    }
    const rawUrl = req.url ?? '/'
    if (rawUrl.includes('..') || rawUrl.includes('\\') || rawUrl.includes('%2e') || rawUrl.includes('%2E')) {
      res.writeHead(403)
      res.end('forbidden path')
      return
    }
    const path = rawUrl.split('?')[0]
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(path)
    } catch {
      res.writeHead(403)
      res.end('invalid path encoding')
      return
    }
    if (decodedPath.includes('..') || decodedPath.includes('\\')) {
      res.writeHead(403)
      res.end('forbidden path')
      return
    }
    const isMetadata =
      /^\/(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(decodedPath) ||
      /^\/@[^/]+\/[^/]+$/i.test(decodedPath)
    const isTarball = /^\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/i.test(decodedPath)
    if (!isMetadata && !isTarball) {
      res.writeHead(403)
      res.end('path not allowed')
      return
    }

    const upstreamUrl = `${this.config.registryUpstream}${path}${rawUrl.includes('?') ? `?${rawUrl.split('?').slice(1).join('?')}` : ''}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          accept: isMetadata ? 'application/vnd.npm.install-v1+json' : String(req.headers.accept ?? 'application/octet-stream'),
          'user-agent': 'paimeng-registry-relay/1.0',
        },
        signal: controller.signal,
        redirect: 'manual',
      })
      if (upstream.status >= 300 && upstream.status < 400) {
        res.writeHead(502)
        res.end('registry redirect refused')
        return
      }
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
      if (isMetadata && contentType.includes('json')) {
        const text = await upstream.text()
        if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
          res.writeHead(502)
          res.end('metadata too large')
          return
        }
        let body = text
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>
          const rewrite = (doc: Record<string, unknown>) => {
            const dist = doc.dist as { tarball?: string } | undefined
            if (dist?.tarball && this.url) {
              try {
                const u = new URL(dist.tarball)
                if (u.hostname !== new URL(this.config.registryUpstream).hostname) return
                dist.tarball = `${this.url}${u.pathname.replace(/^\//, '')}`
              } catch {
                /* 保持原值，后续 npm 拉取会被网络隔离拒绝 */
              }
            }
          }
          if (parsed && typeof parsed === 'object') {
            if (parsed.versions && typeof parsed.versions === 'object') {
              for (const version of Object.values(parsed.versions as Record<string, unknown>)) {
                if (version && typeof version === 'object') rewrite(version as Record<string, unknown>)
              }
            } else if ((parsed as { dist?: unknown }).dist) {
              rewrite(parsed)
            }
          }
          body = JSON.stringify(parsed)
        } catch {
          /* 非 JSON 元数据按原文返回 */
        }
        res.writeHead(upstream.status, {
          'content-type': contentType,
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }

      const reader = upstream.body?.getReader()
      let total = 0
      res.writeHead(upstream.status, {
        'content-type': contentType,
        'cache-control': 'no-store',
      })
      if (!reader || req.method === 'HEAD') {
        res.end()
        return
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_TARBALL_BYTES) {
          res.destroy(new Error('tarball too large'))
          return
        }
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve))
        }
      }
      res.end()
    } finally {
      clearTimeout(timer)
    }
  }

  async onModuleDestroy() {
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      this.server = null
    }
  }
}
