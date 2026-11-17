// 取消（Ctrl-C / CI 取消）后的清理检查：跑真实 e2e 入口，中途 SIGTERM，断言没有残留。
// 需要 Docker 与 Chromium，属于「按需/发布前」检查，不放进每次 PR 的必跑集合。
//   pnpm test:cancel
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { root } from './services.mjs'

// 不能写进 test-results：Playwright 启动时会清空 outputDir，日志会连名字一起消失。
const logPath = join(tmpdir(), `paimeng-cancel-check-${process.pid}.log`)
const watched = [
  'scripts/ci/browser-server.mjs',
  'tests/e2e/backend-process.mjs',
  'paimeng-ai-code-mother-backend/dist/main.js',
]

const pids = (pattern) => {
  const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.split('\n').filter(Boolean).map(Number) : []
}
const containers = () => {
  const found = spawnSync('docker', ['ps', '-a', '--filter', 'label=paimeng.ci', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
  return new Set(found.stdout.split('\n').filter(Boolean))
}
const ports = () => {
  const listening = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' }).stdout
  return new Set(
    listening
      .split('\n')
      .filter((line) => line.includes('node'))
      .map((line) => line.split(/\s+/)[3]),
  )
}
const fresh = (before, after) => [...after].filter((entry) => !before.has(entry))

const before = { containers: containers(), ports: ports() }
const log = openSync(logPath, 'w')
const runner = spawn(process.execPath, [join(root, 'scripts/ci/run.mjs'), 'e2e'], {
  cwd: root,
  stdio: ['ignore', log, log],
  detached: true,
})
closeSync(log)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? `：${detail}` : ''}`)
  if (!ok) failures += 1
}

async function waitForReady(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (runner.exitCode !== null) throw new Error(`runner 提前退出（${runner.exitCode}），见 ${logPath}`)
    let text = ''
    try {
      text = readFileSync(logPath, 'utf8')
    } catch {
      await delay(200)
      continue
    }
    if (text.includes('浏览器测试服务已就绪') && text.includes('Running 4 tests')) return
    await delay(200)
  }
  throw new Error(`runner 未进入用例阶段，见 ${logPath}`)
}

async function waitForGone(probe, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (probe()) return true
    await delay(100)
  }
  console.log(`✖ ${label} 在 ${timeoutMs}ms 内仍然存在`)
  return false
}

try {
  await waitForReady()
  // 让用例真正跑到一半再取消。
  await delay(3000)
  const signalled = Date.now()
  process.kill(runner.pid, 'SIGTERM')
  await waitForGone(() => runner.exitCode !== null, 'runner 退出')
  const elapsed = Date.now() - signalled
  check('取消后 runner 在 15 秒内退出', elapsed < 15_000, `${elapsed}ms`)
  check('取消后 runner 退出码非 0', runner.exitCode !== 0, String(runner.exitCode))
  await delay(1500)
  for (const pattern of watched) {
    const alive = pids(pattern)
    check(`取消后无残留进程 ${pattern}`, alive.length === 0, alive.join(','))
  }
  const newContainers = fresh(before.containers, containers())
  check('取消后无残留测试容器', newContainers.length === 0, newContainers.join(','))
  const newPorts = fresh(before.ports, ports())
  check('取消后无残留监听端口', newPorts.length === 0, newPorts.join(','))
} catch (error) {
  console.error(error.message)
  failures += 1
} finally {
  if (runner.exitCode === null) {
    try {
      process.kill(-runner.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

if (failures) {
  console.error(`取消清理检查失败：${failures} 项`)
  process.exit(1)
}
console.log('取消清理检查通过')
