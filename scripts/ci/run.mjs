import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { browserEnvironment, launcherLimitMs } from '../../tests/e2e/environment.mjs'
import { backend, buildApp, root, run, start, stop, waitFor, withServices } from './services.mjs'

const mode = process.argv[2] ?? 'system'
if (!['integration', 'e2e', 'system'].includes(mode)) throw new Error(`Unknown CI test mode: ${mode}`)
await buildApp(mode !== 'integration')
await withServices(async ({ env }) => {
  if (mode !== 'e2e') {
    const directory = join(backend, 'test/integration')
    const files = (await readdir(directory))
      .filter((file) => file.endsWith('.test.mjs'))
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
    const managed = { ...env, CI_TEST_EXTERNAL_WEBSERVER: '1' }
    const browser = browserEnvironment(managed)
    const server = start(process.execPath, [join(root, 'scripts/ci/browser-server.mjs')], { env: managed })
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`${browser.probeOrigin}/__e2e/ready`, { signal: AbortSignal.timeout(1000) })
          return response.ok
        } catch {
          return false
        }
      }, '浏览器测试服务就绪', 40_000)
      await run('pnpm', ['exec', 'playwright', 'test', '--config', join(root, 'playwright.config.mjs')], {
        env: managed,
        timeoutMs: launcherLimitMs + 60_000,
      })
    } finally {
      await stop(server)
    }
  }
})
