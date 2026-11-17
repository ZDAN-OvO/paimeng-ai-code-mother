import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launcherLimitMs } from '../../tests/e2e/environment.mjs'
import { backend, buildApp, freePorts, root, run, withServices } from './services.mjs'

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
    await run('pnpm', ['exec', 'playwright', 'test', '--config', join(root, 'playwright.config.mjs')], {
      env,
      timeoutMs: launcherLimitMs + 60_000,
    })
  }
})
