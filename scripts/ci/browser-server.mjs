import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, openSync, closeSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { browserEnvironment, repoRoot } from '../../tests/e2e/environment.mjs'
import { createModelServer } from '../../tests/e2e/model-server.mjs'

const env = browserEnvironment()
const frontend = join(repoRoot, 'paimeng-ai-code-mother-frontend/dist')
const main = join(repoRoot, 'paimeng-ai-code-mother-backend/dist/main.js')
const backendLog = join(env.workDir, 'browser-backend.log')
const preservedLog = join(repoRoot, 'test-results', 'browser-backend.log')
const sockets = new Set()
const upstreams = new Set()
const servers = []
let supervisor
let supervisorClosed
let scratch
let stopping = false
let ready = false

function killBackend(signal) {
  if (!supervisor?.pid) return
  try { process.kill(-supervisor.pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') console.error('后端进程组终止失败:', error.code)
  }
}

// 运行目录由根 runner 删除；失败时必须把后端日志搬到会被上传的位置，否则排查线索一起消失。
async function preserveBackendLog(code) {
  try {
    await mkdir(dirname(preservedLog), { recursive: true })
    await copyFile(backendLog, preservedLog)
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`后端日志保存失败: ${error.code}`)
  }
  if (code === 0) return
  try {
    const lines = (await readFile(backendLog, 'utf8')).trimEnd().split('\n')
    console.error(`测试后端日志（末 ${Math.min(lines.length, 40)} 行，完整内容见 test-results/browser-backend.log）：`)
    console.error(lines.slice(-40).join('\n'))
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`后端日志读取失败: ${error.code}`)
  }
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  ready = false
  const hardDeadline = setTimeout(() => {
    killBackend('SIGKILL')
    process.exit(1)
  }, 5_000)
  killBackend('SIGTERM')
  for (const request of upstreams) request.destroy()
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.map((server) => new Promise((done) => {
    server.close(done)
    server.closeAllConnections()
  })))
  if (supervisor) {
    // 守护进程收到 TERM 后在 2 秒内杀整个组；这里再兜底一次。
    await Promise.race([supervisorClosed, delay(2_500)])
    killBackend('SIGKILL')
    await Promise.race([supervisorClosed, delay(500)])
  }
  await preserveBackendLog(code)
  if (scratch) await rm(scratch, { recursive: true, force: true })
  clearTimeout(hardDeadline)
  process.exit(code)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('uncaughtException', (error) => {
  console.error(error.message)
  void shutdown(1)
})
process.on('unhandledRejection', (error) => {
  console.error(error instanceof Error ? error.message : '浏览器启动器异常')
  void shutdown(1)
})
process.on('exit', () => killBackend('SIGKILL'))
// 即便调用方没有清理，也不允许服务器永久驻留。
setTimeout(() => void shutdown(1), 195_000).unref()

async function listen(server, port) {
  server.requestTimeout = 30_000
  server.headersTimeout = 5_000
  server.timeout = 30_000
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  servers.push(server)
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', done)
  })
}

function proxy(req, res) {
  const upstream = httpRequest(`${env.backendOrigin}${req.url}`, {
    method: req.method,
    // 保留真实 Host / Origin / Cookie，预览路由与鉴权仍由后端处理。
    headers: req.headers,
  }, (response) => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
    response.on('error', () => res.destroy())
  })
  upstreams.add(upstream)
  const deadline = setTimeout(() => upstream.destroy(new Error('backend proxy exceeded 60 seconds')), 60_000)
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('backend proxy idle timeout')))
  upstream.on('close', () => { clearTimeout(deadline); upstreams.delete(upstream) })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('测试后端代理连接失败')
  })
  req.on('aborted', () => upstream.destroy())
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.pipe(upstream)
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

async function serve(req, res) {
  const host = req.headers.host?.split(':')[0]
  if (/^app-[1-9]\d*\.preview\.paimeng\.localhost$/.test(host ?? '')) return proxy(req, res)
  if (!['paimeng.localhost', '127.0.0.1'].includes(host)) {
    res.writeHead(421).end()
    return
  }
  const url = new URL(req.url, env.mainOrigin)
  if (url.pathname === '/__e2e/ready') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' }).end(ready ? 'ready' : 'starting')
    return
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res)
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
  const decoded = decodeURIComponent(url.pathname)
  let target = resolve(frontend, `.${decoded}`)
  if (!target.startsWith(`${frontend}${sep}`) && target !== frontend) { res.writeHead(403).end(); return }
  try {
    if (!(await stat(target)).isFile()) target = join(frontend, 'index.html')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // 仅页面路由回退到 index；缺失资源保持 404，避免假阳性的空白预览。
    if (extname(target)) { res.writeHead(404).end(); return }
    target = join(frontend, 'index.html')
  }
  res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(target)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

async function start() {
  await Promise.all([access(main), access(join(frontend, 'index.html'))])
  // 先占用主站和模型端口；端口冲突立即失败，绝不复用其他服务。
  await listen(createModelServer(), env.modelPort)
  const web = createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end('测试静态服务器异常')
    })
  })
  await listen(web, env.webPort)
  // 后端端口也必须空闲，避免把现存进程的健康响应认成自己的服务。
  const probe = createServer()
  await new Promise((done, reject) => {
    probe.once('error', reject)
    probe.listen(env.backendPort, '127.0.0.1', done)
  })
  await new Promise((done) => probe.close(done))
  scratch = await mkdtemp(join(env.workDir, 'browser-runtime-'))
  await mkdir(join(scratch, 'tmp'), { mode: 0o700 })
  const childEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TZ: 'UTC',
    NODE_ENV: 'production', PORT: String(env.backendPort),
    MAIN_ORIGIN: env.mainOrigin, ALLOWED_ORIGINS: env.mainOrigin,
    PREVIEW_DOMAIN: env.previewDomain, PREVIEW_PORT: String(env.webPort), PREVIEW_SCHEME: 'http',
    SESSION_SECRET: 'browser-fixture-session-secret-at-least-32-chars',
    DATABASE_URL: env.databaseUrl, REDIS_URL: env.redisUrl,
    AI_BASE_URL: `${env.modelOrigin}/v1`, AI_KEY: 'browser-fixture-key', AI_MODEL: 'paimeng-e2e-fixed',
    AI_CONTEXT_WINDOW_TOKENS: '128000', AI_OUTPUT_RESERVE_TOKENS: '8192',
    MODEL_TIMEOUT_MS: '25000', RUN_MAX_DURATION_MS: '45000', RUN_MAX_STEPS: '10',
    INSTALL_TIMEOUT_MS: '5000', BUILD_TIMEOUT_MS: '5000', PREVIEW_START_TIMEOUT_MS: '5000',
    RUN_DETAIL_FINALIZE_TIMEOUT_MS: '5000',
    RUNTIME_ROOT: join(scratch, 'runtime'), LOG_DIR: join(scratch, 'logs'), TMPDIR: join(scratch, 'tmp'),
    DOCKER_BIN: '/bin/false', SETUP_IMAGE_ON_START: 'false',
    // 静态流程不会访问 registry；误触发也只能到本地 fixture，不能访问公网。
    REGISTRY_UPSTREAM: env.modelOrigin,
  }
  const log = openSync(backendLog, 'a', 0o600)
  try {
    supervisor = spawn(process.execPath, [join(repoRoot, 'tests/e2e/backend-process.mjs'), main], {
      cwd: env.workDir, env: childEnv, detached: true,
      stdio: ['ignore', log, log, 'ipc'],
    })
  } finally { closeSync(log) }
  supervisorClosed = new Promise((done) => supervisor.once('exit', done))
  supervisor.on('error', () => void shutdown(1))
  supervisor.on('message', (message) => {
    if (message.type === 'backend-exit' && !stopping) {
      console.error('测试后端提前退出，日志会在退出时复制到 test-results/browser-backend.log')
      void shutdown(1)
    }
  })
  supervisor.on('exit', () => { if (!stopping) void shutdown(1) })
  const until = Date.now() + 25_000
  while (Date.now() < until && !stopping) {
    try {
      // readiness 还要求 Docker 镜像；静态套件只要求真实 PG / Redis 可连接。
      const response = await fetch(`${env.backendOrigin}/api/health/ready`, { signal: AbortSignal.timeout(1_000) })
      const body = await response.json()
      if (body.checks?.postgres === 'ok' && body.checks?.redis === 'ok') {
        ready = true
        console.log(`浏览器测试服务已就绪：${env.mainOrigin}`)
        return
      }
    } catch { /* 启动探测按截止时间重试 */ }
    await delay(100)
  }
  if (!stopping) throw new Error('测试后端 25 秒内未就绪，日志会在退出时复制到 test-results/browser-backend.log')
}

start().catch((error) => { console.error(error.message); void shutdown(1) })
