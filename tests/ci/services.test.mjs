import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { start, stop } from '../../scripts/ci/services.mjs'

test('cleanup kills a TERM-ignoring descendant after its process-group leader exits', { timeout: 10_000 }, async () => {
  const descendant = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)`
  const leader = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child.once('message', () => process.send(child.pid))
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  `
  const child = start(process.execPath, ['--input-type=commonjs', '-e', leader], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let pid
  try {
    pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Process fixture did not become ready')), 2000)
      child.once('message', (value) => { clearTimeout(timer); resolve(value) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Leader exited before readiness')) })
    })
    await stop(child)
    // A dead orphan can remain a zombie briefly until the host init reaps it.
    // Neither a zombie nor a missing PID can execute code or keep files/sockets open.
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      assert.match(stat, /\) Z /, 'A live descendant survived cleanup')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    await stop(child)
  }
})

test('cancellation rejects a still-running command instead of waiting for its timeout', { timeout: 20_000 }, async () => {
  const services = new URL('../../scripts/ci/services.mjs', import.meta.url).href
  const stubborn = "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"
  // 用独立进程承接取消，避免污染本文件的模块级取消状态。
  const script = `
    import { run } from ${JSON.stringify(services)}
    const started = Date.now()
    try {
      await run(process.execPath, ['--input-type=commonjs', '-e', ${JSON.stringify(stubborn)}], { timeoutMs: 60_000 })
      process.stdout.write('{"resolved":true}')
    } catch (error) {
      process.stdout.write(JSON.stringify({ resolved: false, elapsed: Date.now() - started, message: error.message }))
    }
  `
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (part) => { output += part })
  const exited = new Promise((resolve) => child.once('close', resolve))
  await new Promise((done) => setTimeout(done, 700))
  const signalled = Date.now()
  process.kill(child.pid, 'SIGTERM')
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  }, 8000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
  assert.ok(output, 'The cancelled runner produced no result')
  const result = JSON.parse(output)
  assert.equal(result.resolved, false, 'A cancelled run must not resolve as success')
  // 关键回归：取消到返回必须远小于命令自身超时，否则清理来不及在 CI 宽限期内执行。
  assert.ok(Date.now() - signalled < 5000, `Cancellation took ${Date.now() - signalled}ms`)
  assert.match(result.message, /interrupted/)
})
