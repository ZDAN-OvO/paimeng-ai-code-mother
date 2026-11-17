import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const backend = join(root, 'paimeng-ai-code-mother-backend')
export const frontend = join(root, 'paimeng-ai-code-mother-frontend')
export const backendRequire = createRequire(join(backend, 'package.json'))

export async function buildApp(includeFrontend = true) {
  await run('pnpm', ['--filter', 'paimeng-ai-code-mother-backend', 'build'])
  if (!includeFrontend) return
  await run(process.execPath, [join(root, 'scripts/ci/build-frontend.mjs')], {
    env: { ...baseEnv, VITE_API_BASE_URL: '/api' },
  })
}

// Do not inherit application configuration or NODE_OPTIONS that could load .env files.
export const baseEnv = Object.fromEntries(
  // CI_TEST_OWNER 是本次运行的归属标记：取消检查靠它认领进程与容器，不会被同机其它运行干扰。
  // TMPDIR 由调用方决定，工作目录因此落在它自己的根目录下。
  ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'TMPDIR', 'CI_TEST_OWNER'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
)

const children = new Set()
const shutdown = new AbortController()
// 取消后先给子进程一个有界窗口自行收尾（Playwright 要关 webServer，启动器要关后端），
// 到点再强杀；全程不用等子进程自己的超时，否则 CI 会在宽限期内被外部强杀。
const ABORT_GRACE_MS = 3000
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown.abort(new Error(`CI interrupted by ${signal}`))
    for (const child of children) {
      terminate(child, 'SIGTERM')
      setTimeout(() => terminate(child, 'SIGKILL'), ABORT_GRACE_MS).unref()
    }
  })
}

function terminate(child, signal = 'SIGTERM') {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function groupAlive(child) {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

export function start(command, args, { cwd = root, env = baseEnv, stdio = 'inherit' } = {}) {
  shutdown.signal.throwIfAborted()
  const child = spawn(command, args, { cwd, env, stdio, detached: true })
  children.add(child)
  child.once('close', () => {
    if (!groupAlive(child)) children.delete(child)
  })
  // A caller awaiting readiness must also see spawn failures.
  child.on('error', () => {})
  return child
}

export async function stop(child) {
  try {
    // 取消时窗口更短，但仍要够启动器关掉它自己的后端进程组。
    const interrupted = shutdown.signal.aborted
    terminate(child, 'SIGTERM')
    const deadline = Date.now() + (interrupted ? ABORT_GRACE_MS : 5000)
    while (groupAlive(child) && Date.now() < deadline) await delay(50)
    // The leader may have exited while a descendant still ignores TERM.
    if (groupAlive(child)) terminate(child, 'SIGKILL')
    // SIGKILL 是异步的：等它落地，调用方拿到的才是「已经不可执行」。
    const killed = Date.now() + 1000
    while (groupAlive(child) && Date.now() < killed) await delay(50)
  } finally {
    children.delete(child)
  }
}

export async function run(command, args, options = {}) {
  const child = start(command, args, options)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    terminate(child, 'SIGKILL')
  }, options.timeoutMs ?? 180_000)
  try {
    const code = await new Promise((resolveCode, reject) => {
      // 取消必须立即打断等待：否则要等到子进程自己的超时才返回，清理来不及执行。
      const onAbort = () => {
        terminate(child, 'SIGTERM')
        setTimeout(() => terminate(child, 'SIGKILL'), ABORT_GRACE_MS).unref()
        reject(shutdown.signal.reason)
      }
      shutdown.signal.addEventListener('abort', onAbort, { once: true })
      child.once('error', (error) => {
        shutdown.signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('close', (code) => {
        shutdown.signal.removeEventListener('abort', onAbort)
        resolveCode(code)
      })
      if (shutdown.signal.aborted) onAbort()
    })
    shutdown.signal.throwIfAborted()
    if (code !== 0) throw new Error(`${command} failed (${timedOut ? 'timeout' : `exit ${code}`})`)
  } finally {
    clearTimeout(timer)
    await stop(child)
  }
}

export function docker(args, timeout = 30_000) {
  const result = spawnSync('docker', args, {
    env: baseEnv,
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

// 固定端口会和本机 vite preview、其他 worktree 的并行运行撞车。开三个 socket 同时取端口，
// 避免同一进程内拿到重复值；真正的占用冲突仍由启动器的显式失败兜底。
export async function freePorts(count) {
  const servers = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer()
      servers.push(server)
      await new Promise((done, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', done)
      })
    }
    return servers.map((server) => server.address().port)
  } finally {
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  }
}

export async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted()
    if (await check()) return
    await delay(150, undefined, { signal: shutdown.signal })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export async function withServices(work) {
  const token = randomUUID().replaceAll('-', '')
  const directory = await mkdtemp(join(tmpdir(), 'paimeng-ci-'))
  const workDir = join(directory, 'work')
  await mkdir(workDir, { mode: 0o700 })
  const containers = []
  let failure
  const addContainer = async (suffix, args) => {
    const name = `paimeng-ci-${token}-${suffix}`
    containers.push(name)
    const labels = ['--label', `paimeng.ci=${token}`]
    if (process.env.CI_TEST_OWNER) labels.push('--label', `paimeng.ci.owner=${process.env.CI_TEST_OWNER}`)
    await run('docker', ['run', '-d', '--name', name, ...labels, ...args], {
      timeoutMs: 180_000,
    })
    return name
  }
  try {
    const database = `paimeng_ci_${token}`
    const postgres = await addContainer('postgres', [
      '-e',
      'POSTGRES_USER=paimeng',
      '-e',
      'POSTGRES_PASSWORD=ci-only',
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ])
    const redis = await addContainer('redis', ['-p', '127.0.0.1::6379', 'redis:7-alpine'])
    const port = (name, containerPort) => {
      const mapping = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports[`${containerPort}/tcp`]
      if (mapping?.length !== 1 || mapping[0].HostIp !== '127.0.0.1')
        throw new Error('Invalid isolated service binding')
      return mapping[0].HostPort
    }
    await waitFor(async () => {
      // The image's initialization server accepts Unix sockets before restarting; require TCP.
      try {
        docker(['exec', postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'paimeng', '-d', database], 3000)
        return true
      } catch {
        return false
      }
    }, 'PostgreSQL')
    await waitFor(async () => {
      try {
        return docker(['exec', redis, 'redis-cli', 'ping'], 3000) === 'PONG'
      } catch {
        return false
      }
    }, 'Redis')
    const [webPort, backendPort, modelPort] = await freePorts(3)
    const env = {
      ...baseEnv,
      CI_TEST_ISOLATED: '1',
      CI_TEST_WORK_DIR: workDir,
      // 显式下发动态端口；baseEnv 是白名单，不会继承宿主上的同名变量。
      CI_TEST_WEB_PORT: String(webPort),
      CI_TEST_BACKEND_PORT: String(backendPort),
      CI_TEST_MODEL_PORT: String(modelPort),
      CI_TEST_DATABASE_URL: `postgres://paimeng:ci-only@127.0.0.1:${port(postgres, 5432)}/${database}`,
      CI_TEST_REDIS_URL: `redis://127.0.0.1:${port(redis, 6379)}/15`,
    }
    const { Pool } = backendRequire('pg')
    const { drizzle } = backendRequire('drizzle-orm/node-postgres')
    const { migrate } = backendRequire('drizzle-orm/node-postgres/migrator')
    const pool = new Pool({
      connectionString: env.CI_TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    })
    try {
      const db = drizzle(pool)
      // Replay all committed migrations into an empty database and verify rerunning is safe.
      await migrate(db, { migrationsFolder: join(backend, 'drizzle') })
      await migrate(db, { migrationsFolder: join(backend, 'drizzle') })
    } finally {
      await pool.end()
    }
    await work({ env, workDir, addContainer, token })
  } catch (error) {
    failure = error
  } finally {
    // 反向停止：后起的子进程先收，避免先杀父进程留下孤儿。
    for (const child of [...children].reverse()) await stop(child)
    for (const name of containers.reverse()) {
      try {
        // Only names created by this invocation; never prune or enumerate by product labels.
        const inspect = spawnSync('docker', ['inspect', name], {
          env: baseEnv,
          encoding: 'utf8',
          timeout: 10_000,
        })
        if (inspect.error || (inspect.status !== 0 && !inspect.stderr.includes('No such object'))) {
          throw new Error('Cannot verify CI container cleanup')
        }
        if (inspect.status === 0) {
          const info = JSON.parse(inspect.stdout)[0]
          if (info.Config.Labels?.['paimeng.ci'] !== token) throw new Error('CI container ownership mismatch')
          docker(['rm', '-fv', name])
        }
      } catch (error) {
        failure ??= error
        console.error(`CI cleanup failed: ${error.message}`)
        console.error(`Remove the leftover container manually: docker rm -fv ${name}`)
      }
    }
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      failure ??= error
    })
  }
  if (failure) throw failure
}
