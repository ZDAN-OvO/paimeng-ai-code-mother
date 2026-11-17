// 独立进程组的守护进程。IPC 断开也会收尾，覆盖启动器被直接杀死的情况。
import { spawn } from 'node:child_process'
import { backendSupervisorLimitMs } from './environment.mjs'

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  try { process.kill(-process.pid, 'SIGTERM') } catch { /* group already gone */ }
  // 不因直接子进程先退出而提前退出；同组后代也必须收到最终 SIGKILL。
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) }
  }, 2_000)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('disconnect', stop)
process.on('uncaughtException', stop)
process.on('unhandledRejection', stop)
setTimeout(stop, backendSupervisorLimitMs).unref()

const backend = spawn(process.execPath, [process.argv[2]], {
  cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
})
backend.on('error', stop)
backend.on('exit', (code, signal) => {
  if (!stopping && process.connected) process.send({ type: 'backend-exit', code, signal })
  stop()
})
