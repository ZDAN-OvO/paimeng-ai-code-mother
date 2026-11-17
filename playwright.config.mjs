import { defineConfig, devices } from '@playwright/test'
import { join } from 'node:path'
import {
  browserEnvironment,
  browserTestLimitMs,
  repoRoot,
  suiteLimitMs,
} from './tests/e2e/environment.mjs'

const env = browserEnvironment()

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  timeout: browserTestLimitMs,
  globalTimeout: suiteLimitMs,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: join(repoRoot, 'test-results'),
  globalTeardown: './tests/e2e/global-teardown.mjs',
  use: {
    baseURL: env.mainOrigin,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] },
  } }],
  webServer: {
    command: 'node scripts/ci/browser-server.mjs',
    url: `${env.probeOrigin}/__e2e/ready`,
    reuseExistingServer: false,
    timeout: 35_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 6_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
