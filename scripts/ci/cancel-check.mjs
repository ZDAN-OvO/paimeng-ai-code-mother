// 取消（Ctrl-C / CI 取消）后的清理检查：跑真实 e2e 入口，中途 SIGTERM，断言本轮资源都收干净。
// 需要 Docker 与 Chromium，属于「按需/发布前」检查，不放进每次 PR 的必跑集合。
//   pnpm test:cancel
//
// 归属靠 CI_TEST_OWNER 标记认领，而不是「跑前跑后的全局差集」：同一台机器上可能有别的 worktree
// 或别的 agent 在跑同一套测试，差集会把它们新建的进程、容器和目录算成本轮残留。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { root } from './services.mjs'

const owner = randomUUID()
// 本轮工作目录落在自己的根目录下，事后这个根目录下不能有本轮的工作目录。
const workRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', `paimeng-cancel-${owner.slice(0, 8)}-`))
const logPath = join(workRoot, 'runner.log')

const probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`)
  return result
}

const readCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// 活着的判断只看 /proc 状态：僵尸进程不能执行代码，算已清理。
const isAlive = (pid) => {
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// 带本轮标记的进程。environ 读不到（EACCES/EPERM）不能当成「不存在」，
// 所以调用方必须结合已经认领过的 pid 做存活复核，而不是只看这一次扫描结果。
const claimedPids = () => {
  const claimed = []
  let unreadable = 0
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let environ
    try {
      environ = readFileSync(`/proc/${entry}/environ`, 'utf8')
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') unreadable += 1
      continue
    }
    if (environ.split('\0').includes(`CI_TEST_OWNER=${owner}`)) claimed.push(Number(entry))
  }
  return { claimed, unreadable }
}

const ownerContainers = () => {
  const result = probe('docker', ['ps', '-a', '--filter', `label=paimeng.ci.owner=${owner}`, '--format', '{{.Names}}'])
  if (result.status !== 0) throw new Error(`docker ps 查询失败（exit ${result.status}）：${result.stderr.trim()}`)
  return result.stdout.split('\n').filter(Boolean)
}

// 只看本轮 runner 自己建的临时工作目录（services.mjs 用 paimeng-ci- 前缀）；
// Node 与 Playwright 在 TMPDIR 里的编译缓存、浏览器 profile 不属于「残留」。
const workRootEntries = () => readdirSync(workRoot).filter((name) => name.startsWith('paimeng-ci-'))

const portOpen = (port) => {
  const result = spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`], { encoding: 'utf8' })
  if (result.error) throw new Error(`端口探测无法执行：${result.error.message}`)
  return result.status === 0
}

const log = openSync(logPath, 'w')
const runner = spawn(process.execPath, [join(root, 'scripts/ci/run.mjs'), 'e2e'], {
  cwd: root,
  stdio: ['ignore', log, log],
  detached: true,
  env: { ...process.env, CI_TEST_OWNER: owner, TMPDIR: workRoot },
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
    const text = readFileSync(logPath, 'utf8')
    if (text.includes('浏览器测试服务已就绪') && text.includes('Running 4 tests')) return text
    await delay(200)
  }
  throw new Error(`runner 未进入用例阶段，见 ${logPath}`)
}

async function waitForGone(probeFn, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (probeFn()) return true
    await delay(100)
  }
  console.log(`✖ ${label} 在 ${timeoutMs}ms 内仍然存在`)
  return false
}

try {
  const readyLog = await waitForReady()
  // 归属机制自检：逐个确认关键进程都被认领，不能只看「认领到几个」。
  const initial = claimedPids()
  const cmdlines = initial.claimed.map((pid) => readCmdline(pid) ?? '')
  const expectClaimed = (label, needle) =>
    check(`${label}已被归属标记认领`, cmdlines.some((line) => line.includes(needle)),
      `已认领 ${initial.claimed.length} 个进程`)
  expectClaimed('runner', 'scripts/ci/run.mjs')
  expectClaimed('浏览器服务', 'scripts/ci/browser-server.mjs')
  expectClaimed('后端守护进程', 'tests/e2e/backend-process.mjs')
  expectClaimed('后端主进程', 'paimeng-ai-code-mother-backend/dist/main.js')
  check('本轮容器可被归属标记识别', ownerContainers().length > 0, ownerContainers().join(','))
  const webPort = Number(/paimeng\.localhost:(\d+)/.exec(readyLog)?.[1])
  check('已记录浏览器服务端口', Number.isInteger(webPort), String(webPort))
  check('取消前浏览器服务端口可用', webPort > 0 && portOpen(webPort))

  await delay(3000)
  const signalled = Date.now()
  process.kill(runner.pid, 'SIGTERM')
  await waitForGone(() => runner.exitCode !== null, 'runner 退出')
  const elapsed = Date.now() - signalled
  check('取消后 runner 在 15 秒内退出', elapsed < 15_000, `${elapsed}ms`)
  check('取消后 runner 退出码非 0', runner.exitCode !== 0, String(runner.exitCode))

  // 清理完成 = 取消前认领到的进程都不再存活，且再次扫描也没有新增带标记的进程。
  const leftovers = () =>
    [...new Set([...initial.claimed, ...claimedPids().claimed])].filter((pid) => isAlive(pid))
  await waitForGone(() => leftovers().length === 0 && ownerContainers().length === 0, '本轮资源清空', 15_000)
  const leftoverPids = leftovers()
  check('取消后无残留进程', leftoverPids.length === 0,
    leftoverPids.map((pid) => `${pid} ${readCmdline(pid) ?? ''}`.trim()).join(' | '))
  const leftoverContainers = ownerContainers()
  check('取消后无残留测试容器', leftoverContainers.length === 0, leftoverContainers.join(','))
  const leftoverEntries = workRootEntries()
  check('取消后无残留临时目录', leftoverEntries.length === 0, leftoverEntries.join(','))
  check('取消后浏览器服务端口已关闭', webPort > 0 && !portOpen(webPort))
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
  console.error(`取消清理检查失败：${failures} 项（日志 ${logPath}）`)
  process.exit(1)
}
console.log(`取消清理检查通过（日志 ${logPath}）`)
