import { createConnection } from 'node:net'
import { writeFileSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { docker, shutdownSignal } from '../ci/services.mjs'

export async function preserveRuntimeEvidence(workDir, resultsDir) {
  await mkdir(resultsDir, { recursive: true })
  for (const name of ['browser-backend.log', 'docker-calls.log']) {
    try {
      await copyFile(join(workDir, name), join(resultsDir, name))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function portClosed(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', (error) => {
      socket.destroy()
      done(error.code === 'ECONNREFUSED')
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
  })
}

// 返回原始失败；清理和取证失败单独记账，不能覆盖触发收尾的原因。
export async function finishLifecycle(resultsDir, lifecycle, isolated, failure, dockerCommand = docker) {
  const errors = lifecycle.cleanupErrors ?? []
  if (isolated) {
    const { env, token } = isolated
    const cleanup = { portsClosed: false, workRemoved: false, containersGone: false }
    lifecycle.cleanup = cleanup
    try {
      cleanup.portsClosed = (
        await Promise.all(
          [env.CI_TEST_WEB_PORT, env.CI_TEST_BACKEND_PORT, env.CI_TEST_MODEL_PORT].map(portClosed),
        )
      ).every(Boolean)
    } catch (error) {
      errors.push(`ports: ${error.message}`)
    }
    try {
      await access(env.CI_TEST_WORK_DIR)
    } catch (error) {
      if (error.code === 'ENOENT') cleanup.workRemoved = true
      else errors.push(`workDir: ${error.message}`)
    }
    try {
      cleanup.containersGone = dockerCommand(['ps', '-aq', '--filter', `label=paimeng.ci=${token}`]) === ''
    } catch (error) {
      errors.push(`docker: ${error.message}`)
    }
  }
  lifecycle.cleanupErrors = errors
  try {
    await mkdir(resultsDir, { recursive: true })
    if (shutdownSignal.aborted) {
      lifecycle.interruption = shutdownSignal.reason.message
      failure ??= shutdownSignal.reason
    }
    if (!lifecycle.cleanup || Object.values(lifecycle.cleanup).some((ok) => !ok) || errors.length) {
      failure ??= new Error('隔离实例清理未通过，见 lifecycle.json')
    }
    if (failure) lifecycle.error = failure.message
    writeFileSync(join(resultsDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2) + '\n')
  } catch (error) {
    errors.push(`lifecycle: ${error.message}`)
    console.error(`生命周期证据保存失败：${error.message}`)
    failure ??= shutdownSignal.reason ?? error
  }
  return failure
}

export async function readLifecycle(directory) {
  return JSON.parse(await readFile(join(directory, 'lifecycle.json'), 'utf8'))
}

export function writeManifest(directory, report) {
  // 产物哈希等异步工作完成后，连续完成取消检查和最终写入。
  if (shutdownSignal.aborted) {
    report.interruption = shutdownSignal.reason.message
    report.error ??= report.interruption
    report.ok = false
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
}
