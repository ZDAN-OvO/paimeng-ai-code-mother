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
