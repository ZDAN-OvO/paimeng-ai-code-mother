import { finishLifecycle, preserveRuntimeEvidence } from '../verify/evidence.mjs'
import { fileURLToPath } from 'node:url'
import { featureFiles } from '../verify/features.mjs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { browserEnvironment, launcherLimitMs } from '../../tests/e2e/environment.mjs'
import { backend, buildApp, root, run, start, stop, waitFor, withServices } from './services.mjs'

const resultsRoot = join(root, 'test-results')
// 每次运行一个独占目录：并行运行时后启动的 Playwright 不会清掉前一套的 trace。
const defaultResultsDir = join(
  resultsRoot,
  `run-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`,
)
// 旧目录没人清理会一直堆；只删一天以前的，避免碰到同时进行的另一次运行。
async function pruneOldRuns() {
  let entries
  try {
    entries = await readdir(resultsRoot)
  } catch {
    return
  }
  const cutoff = Date.now() - 24 * 3600 * 1000
  for (const entry of entries) {
    if (!entry.startsWith('run-')) continue
    const path = join(resultsRoot, entry)
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
    } catch {
      // 并发删除或权限问题都不该影响本次运行
    }
  }
}

export async function runSuite(mode = 'system', feature, proof) {
  if (!['integration', 'e2e', 'system'].includes(mode)) throw new Error(`Unknown CI test mode: ${mode}`)
  if ((feature && mode === 'system') || (proof && !isAbsolute(proof))) {
    throw new Error('用法：run.mjs <integration|e2e|system> [feature [绝对证据目录]]')
  }
  const selected = feature && mode === 'e2e' ? featureFiles(feature) : []
  if (
    mode === 'integration' &&
    feature &&
    !(await readdir(join(backend, 'test/integration'))).includes(`${feature}.test.mjs`)
  )
    throw new Error('未知集成测试模块')
  const resultsDir = proof ?? defaultResultsDir
  const lifecycle = { model: 'paimeng-e2e-fixed', feature: feature ?? 'all', ready: false, cleanup: null }
  let isolated
  let failure
  try {
    await buildApp(mode !== 'integration')
    await withServices(async ({ env, token }) => {
      isolated = { env, token }
      lifecycle.isolation = {
        token,
        workDir: env.CI_TEST_WORK_DIR,
        containers: [`paimeng-ci-${token}-postgres`, `paimeng-ci-${token}-redis`],
      }

      try {
        if (mode !== 'e2e') {
          const directory = join(backend, 'test/integration')
          const files = (await readdir(directory))
            .filter((file) => file.endsWith('.test.mjs') && (!feature || file === `${feature}.test.mjs`))
            .map((file) => join(directory, file))
          if (files.length === 0) throw new Error('No integration tests were discovered')
          await run(process.execPath, ['--test', ...files], {
            env,
            timeoutMs: 90_000,
          })
        }
        if (mode !== 'integration') {
          // 浏览器服务由 runner 自己拉起：它是 children 里的一员，取消时会被一起收掉。
          // 交给 Playwright 起则会变成它的子进程，Playwright 被强杀后它就脱离掌控继续占端口。
          if (!proof) await pruneOldRuns()
          await mkdir(resultsDir, { recursive: true })
          const managed = {
            ...env,
            CI_TEST_EXTERNAL_WEBSERVER: '1',
            CI_TEST_RESULTS_DIR: resultsDir,
            ...(proof ? { CI_TEST_EVIDENCE: '1' } : {}),
          }
          const browser = browserEnvironment(managed)
          const server = start(process.execPath, [join(root, 'scripts/ci/browser-server.mjs')], {
            env: managed,
          })
          // 启动失败要立刻报错，不要让就绪等待空耗满 40 秒。
          const exited = new Promise((_, reject) => {
            server.once('exit', (code, signal) =>
              reject(new Error(`浏览器测试服务提前退出（${signal ?? code}），见上方输出`)),
            )
            server.once('error', (error) => reject(new Error(`浏览器测试服务无法启动：${error.message}`)))
          })
          exited.catch(() => {})
          try {
            await Promise.race([
              waitFor(
                async () => {
                  try {
                    const response = await fetch(`${browser.probeOrigin}/__e2e/ready`, {
                      signal: AbortSignal.timeout(1000),
                    })
                    return response.ok
                  } catch {
                    return false
                  }
                },
                '浏览器测试服务就绪',
                40_000,
              ),
              exited,
            ])
            lifecycle.ready = true
            lifecycle.ports = [browser.webPort, browser.backendPort, browser.modelPort]
            await run(
              'pnpm',
              ['exec', 'playwright', 'test', ...selected, '--config', join(root, 'playwright.config.mjs')],
              {
                env: managed,
                timeoutMs: launcherLimitMs + 60_000,
              },
            )
          } finally {
            await stop(server)
          }
        }
      } finally {
        if (proof) {
          try {
            await preserveRuntimeEvidence(env.CI_TEST_WORK_DIR, resultsDir)
          } catch (error) {
            lifecycle.cleanupErrors = [`evidence: ${error.message}`]
          }
        }
      }
    })
  } catch (error) {
    failure = error
  } finally {
    if (proof) failure = await finishLifecycle(resultsDir, lifecycle, isolated, failure)
  }
  if (failure) throw failure
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 5) throw new Error('run.mjs 参数过多')
  await runSuite(process.argv[2], process.argv[3], process.argv[4])
}
