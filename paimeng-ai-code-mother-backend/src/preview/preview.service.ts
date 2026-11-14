import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import httpProxy from 'http-proxy'
import { AppConfigService } from '../config/config.module'
import { ApiException } from '../common/api'
import { DbService } from '../db/db.module'
import { agentRuns, apps } from '../db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { RedisService } from '../redis/redis.module'
import { DockerService } from '../runtime/docker.service'
import { RuntimeService } from '../runtime/runtime.service'
import { stableDependencyHash } from '../runtime/dependency-policy'
import { SessionService } from '../auth/session.service'
import { shouldRecyclePreview } from './preview-policy'

const TICKET_PREFIX = 'preview:ticket:'
const AUTH_PREFIX = 'preview:auth:'
const REFRESH_SCRIPT = `;(function () {
  var version = null
  function poll() {
    fetch('/__platform/version', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        if (!data) return
        if (version === null) { version = data.version; return }
        if (data.version !== version) window.location.reload()
      })
      .catch(function () {})
  }
  setInterval(poll, 1000)
  poll()
})()
`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

interface PreviewState {
  status: 'stopped' | 'starting' | 'running' | 'failed'
  kind: 'static' | 'vue' | 'react' | null
  ip: string | null
  port: number | null
  lastError: string | null
  lastHeartbeat: number
  startedAt: number | null
  depsHash: string | null
}

@Injectable()
export class PreviewService implements OnModuleDestroy {
  private readonly logger = new Logger(PreviewService.name)
  private readonly states = new Map<number, PreviewState>()
  private readonly versions = new Map<number, number>()
  private readonly proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false, xfwd: false })
  private readonly sockets = new Map<number, Set<Socket>>()
  private readonly socketMeta = new Map<Socket, { appId: number; sessionId: string; token: string }>()
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly config: AppConfigService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly docker: DockerService,
    private readonly runtime: RuntimeService,
    private readonly sessions: SessionService,
  ) {
    this.proxy.on('error', (err) => {
      this.logger.warn(`预览代理错误: ${err.message}`)
    })
    this.proxy.on('proxyRes', (proxyRes, req, res) => {
      const appId = this.parsePreviewHost(req.headers.host)
      if (!appId) return
      delete proxyRes.headers['set-cookie']
      delete proxyRes.headers['content-security-policy']
      delete proxyRes.headers['x-frame-options']
      delete proxyRes.headers['referrer-policy']
      delete proxyRes.headers['preview-app-id']
      if (typeof (res as ServerResponse).setHeader === 'function') {
        this.applyPreviewHeaders(res as ServerResponse, appId)
      }
    })
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), 30_000)
    this.cleanupTimer.unref()
  }

  async onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    for (const appId of this.states.keys()) await this.stopContainer(appId)
  }

  previewUrl(appId: number) {
    return this.config.previewUrl(appId)
  }

  private state(appId: number): PreviewState {
    let state = this.states.get(appId)
    if (!state) {
      state = {
        status: 'stopped',
        kind: null,
        ip: null,
        port: null,
        lastError: null,
        lastHeartbeat: Date.now(),
        startedAt: null,
        depsHash: null,
      }
      this.states.set(appId, state)
    }
    return state
  }

  async getStatus(appId: number) {
    const info = await this.runtime.detectProject(appId)
    const kind = info.hasPackageJson ? info.kind : 'static'
    const state = this.states.get(appId)
    let status: 'stopped' | 'starting' | 'running' | 'failed'
    if (kind === 'static') {
      status = existsSync(join(this.config.appSourceDir(appId), 'index.html')) ? 'running' : 'stopped'
    }
    else status = state?.status ?? 'stopped'
    if (status === 'running' && (kind === 'vue' || kind === 'react')) {
      const running = await this.docker.containerRunning(`paimeng-app-${appId}`)
      if (!running) {
        if (state) state.status = 'stopped'
        status = 'stopped'
      }
    }
    return {
      status,
      kind,
      url: status === 'stopped' ? null : this.config.previewUrl(appId),
      lastError: state?.lastError ?? null,
    }
  }

  async version(appId: number): Promise<string> {
    const info = await this.runtime.detectProject(appId)
    if (!info.hasPackageJson) return this.sourceSignature(appId)
    return String(this.versions.get(appId) ?? 1)
  }

  private async sourceSignature(appId: number): Promise<string> {
    const root = this.config.appSourceDir(appId)
    const entries: string[] = []
    const walk = async (dir: string, prefix: string) => {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        if (item.name === 'node_modules' || item.name === '.git') continue
        const rel = prefix ? `${prefix}/${item.name}` : item.name
        const full = join(dir, item.name)
        if (item.isDirectory()) {
          await walk(full, rel)
        } else if (item.isFile()) {
          try {
            const st = await stat(full)
            entries.push(`${rel}:${st.size}:${st.mtimeMs}`)
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(root, '')
    entries.sort()
    return createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 16)
  }

  markChanged(appId: number) {
    this.versions.set(appId, (this.versions.get(appId) ?? 1) + 1)
  }

  async ensurePreview(
    appId: number,
    isCancelled: () => boolean = () => false,
  ): Promise<{ status: PreviewState['status']; error?: string }> {
    const info = await this.runtime.detectProject(appId)
    const kind: 'static' | 'vue' | 'react' = info.hasPackageJson ? info.kind : 'static'
    const state = this.state(appId)
    state.kind = kind
    if (kind === 'static') {
      if (!existsSync(join(this.config.appSourceDir(appId), 'index.html'))) {
        state.status = 'failed'
        state.lastError = '静态项目缺少入口文件 index.html'
        return { status: 'failed', error: state.lastError }
      }
      state.status = 'running'
      state.startedAt = state.startedAt ?? Date.now()
      state.lastError = null
      return { status: 'running' }
    }
    if (!info.hasDev) {
      state.status = 'failed'
      state.lastError = 'package.json 缺少平台约定的 dev 脚本，无法启动实时预览'
      return { status: 'failed', error: state.lastError }
    }
    const depsHash = info.manifest ? stableDependencyHash(info.manifest) : null
    if (state.status === 'running' && state.ip) {
      const running = await this.docker.containerRunning(`paimeng-app-${appId}`)
      if (running && state.depsHash && depsHash && state.depsHash !== depsHash) {
        await this.stopContainer(appId)
      } else if (
        running &&
        (await this.runtime.isPortOpen(state.ip, state.port ?? 3000)) &&
        (await this.runtime.probeHttp(state.ip, state.port ?? 3000, '/'))
      ) {
        return { status: 'running' }
      }
    }
    const active = [...this.states.entries()].filter(
      ([id, s]) => id !== appId && s.status === 'running' && (s.kind === 'vue' || s.kind === 'react'),
    ).length
    if (active >= this.config.maxActivePreviews) {
      await this.cleanupIdle()
      const after = [...this.states.entries()].filter(
        ([id, s]) => id !== appId && s.status === 'running' && (s.kind === 'vue' || s.kind === 'react'),
      ).length
      if (after >= this.config.maxActivePreviews) {
        state.status = 'failed'
        state.lastError = `并发预览已达上限（${this.config.maxActivePreviews} 个）`
        return { status: 'failed', error: state.lastError }
      }
    }
    const deps = await this.runtime.ensureDependencies(appId, isCancelled)
    if (!deps.ok) {
      state.status = 'failed'
      state.lastError = deps.error ?? '依赖安装失败'
      return { status: 'failed', error: state.lastError }
    }
    state.status = 'starting'
    state.lastError = null
    const started = await this.runtime.startPreviewContainer(appId, isCancelled)
    if (!started.ok) {
      state.status = 'failed'
      state.lastError = started.error ?? '预览启动失败'
      this.logger.warn(`应用 ${appId} 预览启动失败: ${state.lastError}`)
      return { status: 'failed', error: state.lastError }
    }
    state.status = 'running'
    state.depsHash = depsHash
    state.ip = started.ip ?? null
    state.port = started.port ?? 3000
    state.startedAt = Date.now()
    state.lastHeartbeat = Date.now()
    this.logger.log(`应用 ${appId} 预览已启动（${state.ip}:${state.port}）`)
    return { status: 'running' }
  }

  async restart(appId: number) {
    await this.stopContainer(appId)
    this.states.delete(appId)
    return this.ensurePreview(appId)
  }

  private async stopContainer(appId: number) {
    const state = this.states.get(appId)
    await this.runtime.stopPreviewContainer(appId)
    this.closeSockets(appId)
    if (state) {
      state.status = 'stopped'
      state.ip = null
      state.port = null
      state.startedAt = null
    }
  }

  async stopForStatic(appId: number) {
    await this.stopContainer(appId)
    const state = this.states.get(appId)
    if (state) {
      state.status = 'stopped'
      state.ip = null
      state.port = null
      state.startedAt = null
      state.lastError = null
    }
  }

  async stopForDelete(appId: number) {
    await this.stopContainer(appId)
    this.states.delete(appId)
    this.versions.delete(appId)
    await this.clearAuthForApp(appId)
  }

  revokeApp(appId: number, _reason: string) {
    this.closeSockets(appId)
    void this.clearAuthForApp(appId)
    const state = this.states.get(appId)
    if (state) {
      state.status = 'stopped'
      state.ip = null
      state.port = null
    }
  }

  private closeSockets(appId: number) {
    const set = this.sockets.get(appId)
    if (!set) return
    for (const socket of set) {
      this.socketMeta.delete(socket)
      socket.destroy()
    }
    this.sockets.delete(appId)
  }

  async revokeSession(sessionId: string) {
    for (const [socket, meta] of [...this.socketMeta]) {
      if (meta.sessionId !== sessionId) continue
      this.socketMeta.delete(socket)
      this.sockets.get(meta.appId)?.delete(socket)
      socket.destroy()
    }
    const client = await this.redis.ensureConnected()
    let cursor = '0'
    do {
      const scan = await client.scan(cursor, { MATCH: `preview:lease:${sessionId}:*`, COUNT: 200 })
      cursor = scan.cursor
      for (const key of scan.keys) {
        const token = await client.get(key)
        if (token) await client.del(`${AUTH_PREFIX}${token}`)
        await client.del(key)
      }
    } while (cursor !== '0')
  }

  private async clearAuthForApp(appId: number) {
    const client = await this.redis.ensureConnected()
    let cursor = '0'
    do {
      const scan = await client.scan(cursor, { MATCH: `${AUTH_PREFIX}*`, COUNT: 200 })
      cursor = scan.cursor
      for (const key of scan.keys) {
        const raw = await client.get(key)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw) as { appId?: number }
          if (parsed.appId === appId) await client.del(key)
        } catch {
          await client.del(key)
        }
      }
    } while (cursor !== '0')
  }

  async cleanupIdle() {
    try {
      const now = Date.now()
      for (const [appId, state] of this.states) {
        if (state.status !== 'running' || state.kind === 'static') continue
        const [running] = await this.db.db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(and(eq(agentRuns.appId, appId), inArray(agentRuns.status, ['running', 'cancelling'])))
          .limit(1)
        if (
          shouldRecyclePreview({
            status: state.status,
            kind: state.kind,
            hasRunningRun: Boolean(running),
            lastHeartbeat: state.lastHeartbeat,
            now,
            idleMs: this.config.previewIdleMs,
          })
        ) {
          this.logger.log(`回收空闲预览 ${appId}`)
          await this.stopContainer(appId)
        }
      }
      await this.closeExpiredSockets()
    } catch (err) {
      this.logger.warn(`预览清理失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async closeExpiredSockets() {
    if (this.socketMeta.size === 0) return
    const client = await this.redis.ensureConnected()
    for (const [socket, meta] of [...this.socketMeta]) {
      const alive = await client.exists(`${AUTH_PREFIX}${meta.token}`)
      if (alive === 1) continue
      this.socketMeta.delete(socket)
      this.sockets.get(meta.appId)?.delete(socket)
      socket.destroy()
    }
  }

  async issueTicket(appId: number, userId: number, sessionId: string) {
    const [app] = await this.db.db.select().from(apps).where(eq(apps.id, appId)).limit(1)
    if (!app || app.ownerId !== userId) throw ApiException.forbidden('无权访问该应用')
    if (app.status !== 'active') throw ApiException.conflict('应用不可访问')
    const ticket = randomBytes(24).toString('hex')
    const client = await this.redis.ensureConnected()
    await client.set(`${TICKET_PREFIX}${ticket}`, JSON.stringify({ appId, userId, sessionId }), {
      EX: Math.floor(this.config.previewTicketTtlMs / 1000),
    })
    return { ticket, expiresIn: Math.floor(this.config.previewTicketTtlMs / 1000) }
  }

  get ticketTtlSeconds() {
    return Math.floor(this.config.previewTicketTtlMs / 1000)
  }

  async establishSession(ticket: string, hostAppId: number) {
    const client = await this.redis.ensureConnected()
    const key = `${TICKET_PREFIX}${ticket}`
    const raw = await client.getDel(key)
    if (!raw) throw new Error('票据无效或已过期')
    const data = JSON.parse(raw) as { appId: number; userId: number; sessionId: string }
    if (data.appId !== hostAppId) throw new Error('票据与应用不匹配')
    const [app] = await this.db.db.select().from(apps).where(eq(apps.id, hostAppId)).limit(1)
    if (!app || app.status !== 'active' || app.ownerId !== data.userId) throw new Error('应用不可访问')
    if (!(await this.sessions.exists(data.sessionId))) throw new Error('登录状态已失效')
    const token = randomBytes(32).toString('hex')
    const ttlSeconds = Math.floor(this.config.previewAuthTtlMs / 1000)
    await client.set(`${AUTH_PREFIX}${token}`, JSON.stringify(data), { EX: ttlSeconds })
    await client.set(`preview:lease:${data.sessionId}:${hostAppId}`, token, { EX: ttlSeconds })
    return { token, maxAge: ttlSeconds }
  }

  private parseCookie(req: IncomingMessage): string | null {
    const raw = req.headers.cookie
    if (!raw) return null
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === this.config.previewCookieName) return part.slice(idx + 1).trim()
    }
    return null
  }

  parsePreviewHost(host: string | undefined): number | null {
    if (!host) return null
    const clean = host.split(':')[0].toLowerCase()
    const escaped = this.config.previewDomain.replace(/\./g, '\\.')
    const match = new RegExp(`^app-(\\d+)\\.${escaped}$`).exec(clean)
    if (!match) return null
    const id = Number(match[1])
    return Number.isInteger(id) && id > 0 ? id : null
  }

  async authorize(req: IncomingMessage, appId: number) {
    const token = this.parseCookie(req)
    if (!token) return null
    const client = await this.redis.ensureConnected()
    const raw = await client.get(`${AUTH_PREFIX}${token}`)
    if (!raw) return null
    const data = JSON.parse(raw) as { appId: number; userId: number; sessionId: string }
    if (data.appId !== appId) return null
    if (!(await this.sessions.exists(data.sessionId))) return null
    const [app] = await this.db.db.select().from(apps).where(eq(apps.id, appId)).limit(1)
    if (!app || app.status !== 'active' || app.ownerId !== data.userId) return null
    return { ...data, token }
  }

  async heartbeat(appId: number, sessionId: string) {
    const client = await this.redis.ensureConnected()
    const leaseKey = `preview:lease:${sessionId}:${appId}`
    const token = await client.get(leaseKey)
    if (!token) return false
    const key = `${AUTH_PREFIX}${token}`
    const raw = await client.get(key)
    if (!raw) return false
    const data = JSON.parse(raw) as { appId: number; sessionId: string }
    if (data.appId !== appId || data.sessionId !== sessionId) return false
    const ttlSeconds = Math.floor(this.config.previewAuthTtlMs / 1000)
    await client.expire(key, ttlSeconds)
    await client.expire(leaseKey, ttlSeconds)
    const state = this.state(appId)
    state.lastHeartbeat = Date.now()
    return true
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, appId: number, urlPath: string) {
    this.applyPreviewHeaders(res, appId)
    urlPath = urlPath.split('?')[0] || '/'
    try {
      if (urlPath === '/__platform/access') {
        if (req.method !== 'POST') {
          this.writePlain(res, 405, '预览授权只接受 POST')
          return
        }
        await this.handleAccess(req, res, appId)
        return
      }
      const auth = await this.authorize(req, appId)
      if (!auth) {
        const accept = String(req.headers.accept ?? '')
        const destination = String(req.headers['sec-fetch-dest'] ?? '')
        if (destination === 'document' && accept.includes('text/html')) {
          res.writeHead(302, {
            Location: `${this.config.mainOrigin}/app/chat/${appId}`,
            'Cache-Control': 'no-store',
          })
          res.end()
          return
        }
        this.writePlain(res, 401, '预览未授权或授权已过期，请在主站重新打开预览')
        return
      }
      if (Math.random() < 0.02) {
        const state = this.state(appId)
        state.lastHeartbeat = Date.now()
      }
      if (urlPath === '/__platform/refresh.js') {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(REFRESH_SCRIPT)
        return
      }
      if (urlPath === '/__platform/version') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ version: await this.version(appId) }))
        return
      }
      const info = await this.runtime.detectProject(appId)
      if (!info.hasPackageJson) {
        await this.serveStatic(appId, urlPath, res)
        return
      }
      const state = this.state(appId)
      if (state.status !== 'running' || !state.ip) {
        const ensured = await this.ensurePreview(appId)
        if (ensured.status !== 'running') {
          this.writePlain(res, 503, `预览启动失败：${ensured.error ?? '未知原因'}`)
          return
        }
      }
      this.proxyHttp(req, res, appId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(`预览请求处理失败: ${message}`)
      this.writePlain(res, 500, '预览服务内部错误')
    }
  }

  private async handleAccess(req: IncomingMessage, res: ServerResponse, appId: number) {
    const ticket = new URLSearchParams(await this.readBody(req)).get('ticket') ?? ''
    const secure = this.config.previewScheme === 'https' ? '; Secure' : ''
    try {
      const { token, maxAge } = await this.establishSession(ticket, appId)
      // 使用 204 避免隐藏授权 frame 再加载一次应用；cookie 由预览来源的响应写入。
      res.writeHead(204, {
        'Set-Cookie': `${this.config.previewCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
        'Cache-Control': 'no-store',
      })
      res.end()
    } catch (err) {
      const message = err instanceof Error ? err.message : '授权失败'
      this.writePlain(res, 403, message)
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      let data = ''
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 4096) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        data += chunk.toString('utf8')
      })
      req.on('end', () => resolveBody(data))
      req.on('error', reject)
    })
  }

  private async serveStatic(appId: number, urlPath: string, res: ServerResponse) {
    const root = this.config.appSourceDir(appId)
    let rel: string
    try {
      rel = decodeURIComponent(urlPath.split('?')[0] ?? '/')
    } catch {
      this.writePlain(res, 400, '非法路径')
      return
    }
    if (rel.endsWith('/')) rel += 'index.html'
    if (rel === '/') rel = '/index.html'
    const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
    let file = resolve(root, safeRel)
    if (!file.startsWith(resolve(root) + sep) && file !== resolve(root)) {
      this.writePlain(res, 403, '路径越界')
      return
    }
    try {
      const real = await realpath(file)
      if (!real.startsWith(resolve(root) + sep)) {
        this.writePlain(res, 403, '路径越界')
        return
      }
      file = real
    } catch {
      file = join(root, 'index.html')
    }
    if (!existsSync(file)) {
      this.writePlain(res, 404, '文件不存在')
      return
    }
    const ext = extname(file).toLowerCase()
    const contentType = MIME[ext] ?? 'application/octet-stream'
    const buffer = await readFile(file)
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    if (ext === '.html') {
      const html = buffer.toString('utf8')
      const injected = html.includes('</body>')
        ? html.replace('</body>', '<script src="/__platform/refresh.js"></script></body>')
        : `${html}<script src="/__platform/refresh.js"></script>`
      headers['Content-Length'] = String(Buffer.byteLength(injected))
      res.writeHead(200, headers)
      res.end(injected)
      return
    }
    headers['Content-Length'] = String(buffer.length)
    res.writeHead(200, headers)
    res.end(buffer)
  }

  private proxyHttp(req: IncomingMessage, res: ServerResponse, appId: number) {
    const state = this.state(appId)
    if (!state.ip) {
      this.writePlain(res, 503, '预览尚未就绪')
      return
    }
    delete req.headers.cookie
    delete req.headers.authorization
    delete req.headers['x-forwarded-for']
    delete req.headers['x-real-ip']
    this.proxy.web(req, res, { target: { host: state.ip, port: state.port ?? 3000 } }, (err) => {
      if (!res.headersSent) this.writePlain(res, 502, `预览连接失败：${err.message}`)
      else res.destroy()
    })
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const host = req.headers.host
    const appId = this.parsePreviewHost(host)
    if (!appId) {
      socket.destroy()
      return
    }
    void (async () => {
      const auth = await this.authorize(req, appId)
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const state = this.state(appId)
      if (state.status !== 'running' || !state.ip) {
        const ensured = await this.ensurePreview(appId)
        if (ensured.status !== 'running') {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
      }
      const current = this.state(appId)
      if (!current.ip) {
        socket.destroy()
        return
      }
      let set = this.sockets.get(appId)
      if (!set) {
        set = new Set()
        this.sockets.set(appId, set)
      }
      set.add(socket)
      this.socketMeta.set(socket, { appId, sessionId: auth.sessionId, token: auth.token })
      socket.on('close', () => {
        set?.delete(socket)
        this.socketMeta.delete(socket)
      })
      delete req.headers.cookie
      delete req.headers.authorization
      this.proxy.ws(req, socket, head, { target: { host: current.ip, port: current.port ?? 3000 } })
    })()
  }

  applyPreviewHeaders(res: ServerResponse, appId: number) {
    const main = this.config.mainOrigin
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'none'",
        "worker-src 'none'",
        `frame-ancestors 'self' ${main}`,
        'sandbox allow-scripts allow-same-origin allow-forms',
      ].join('; '),
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Preview-App-Id', String(appId))
  }

  private writePlain(res: ServerResponse, status: number, message: string) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(message)
  }
  async resetStates() {
    this.states.clear()
    this.versions.clear()
  }

}
