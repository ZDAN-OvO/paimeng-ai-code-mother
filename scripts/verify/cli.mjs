#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { baseEnv, root } from '../ci/services.mjs'
import { runSuite } from '../ci/run.mjs'
import { readLifecycle } from './evidence.mjs'
import { features, featureFiles } from './features.mjs'

const [command = 'help', feature = 'all', ...extra] = process.argv.slice(2)
if (
  extra.length ||
  (command !== 'run' && process.argv.length > 3) ||
  !['help', '--help', 'list', 'doctor', 'run'].includes(command)
) {
  console.error('用法：pnpm verify <list|doctor|run [generation|access|steer|cancellation|recovery|all]>')
  process.exit(2)
}

async function artifacts(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await artifacts(directory, relative)))
    else if (entry.isFile() && relative !== 'manifest.json') {
      const body = await readFile(join(directory, relative))
      result.push({
        path: relative,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
    }
  }
  return result
}

async function doctor() {
  const probe = (name, command, args) => {
    const result = spawnSync(command, args, { cwd: root, env: baseEnv, encoding: 'utf8', timeout: 10_000 })
    return { name, ok: !result.error && result.status === 0 }
  }
  const checks = [
    {
      name: 'node>=22.8',
      ok:
        Number(process.versions.node.split('.')[0]) > 22 ||
        (Number(process.versions.node.split('.')[0]) === 22 &&
          Number(process.versions.node.split('.')[1]) >= 8),
    },
    probe('pnpm', 'pnpm', ['--version']),
    probe('docker-daemon', 'docker', ['info', '--format', '{{.ServerVersion}}']),
  ]
  try {
    const { chromium } = await import('@playwright/test')
    const { access } = await import('node:fs/promises')
    await access(chromium.executablePath())
    checks.push({ name: 'chromium-installed', ok: true })
  } catch {
    checks.push({ name: 'chromium-installed', ok: false })
  }
  return { ok: checks.every((check) => check.ok), checks }
}

try {
  if (command === 'help' || command === '--help') {
    console.log(
      'pnpm verify list | doctor | run [feature|all]\nrun 自动构建、启动隔离实例、检查就绪、驱动浏览器、保存证据并清理。\n使用固定模型与真实 PostgreSQL/Redis；生成应用的 Docker 执行被审计替身拦截。\n不连接开发实例，不调用真实模型。证据保留在 test-results/verify-*/。',
    )
  } else if (command === 'list') {
    console.log(JSON.stringify({ features, all: '全部功能' }, null, 2))
  } else if (command === 'doctor') {
    const result = await doctor()
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } else {
    featureFiles(feature)
    const preflight = await doctor()
    if (!preflight.ok) throw new Error(`预检失败：${JSON.stringify(preflight)}`)
    const directory = join(root, 'test-results', `verify-${Date.now()}-${randomUUID().slice(0, 8)}`)
    await mkdir(directory, { recursive: true })
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim()
    const dirty =
      spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout?.trim() !== ''
    const report = {
      feature,
      head,
      dirty,
      model: 'paimeng-e2e-fixed',
      runtime: 'docker-audit',
      preflight,
      startedAt: new Date().toISOString(),
      ok: false,
      directory,
    }
    try {
      await runSuite('e2e', feature, directory)
      const result = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
      if (
        result.stats?.expected !== (feature === 'all' ? Object.keys(features).length : 1) ||
        result.stats?.unexpected ||
        result.stats?.skipped ||
        result.stats?.flaky
      ) {
        throw new Error('验证结果缺少预期用例，或存在失败、跳过、重试')
      }
      report.lifecycle = await readLifecycle(directory)
      if (
        !report.lifecycle.ready ||
        !report.lifecycle.cleanup ||
        Object.values(report.lifecycle.cleanup).some((ok) => !ok)
      )
        throw new Error('实例就绪或清理证明不完整')
      report.artifacts = await artifacts(directory)
      if (
        !report.artifacts.some((item) => item.path.endsWith('trace.zip') && item.bytes > 0) ||
        !report.artifacts.some((item) => item.path.endsWith('.png') && item.bytes > 0)
      ) {
        throw new Error('缺少浏览器操作轨迹或截图')
      }
      report.ok = true
    } catch (error) {
      report.error = error.message
      process.exitCode = 1
    } finally {
      if (!report.lifecycle) {
        try {
          report.lifecycle = await readLifecycle(directory)
        } catch (error) {
          report.lifecycleError = error.message
        }
      }
      report.artifacts ??= await artifacts(directory)
      report.finishedAt = new Date().toISOString()
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify(report, null, 2))
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
