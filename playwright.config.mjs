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
  // 同一 checkout 可能有多个运行在并行（多个 worktree / agent）；共用 outputDir 会被
  // 后启动的 Playwright 清空，导致前一个运行的 trace 在用例中途消失。
  // 配置会被主进程和每个 worker 各自加载一次，所以目录名必须由 runner 传入，
  // 在这里现算会算出多个目录。
  outputDir: process.env.CI_TEST_RESULTS_DIR ?? join(repoRoot, 'test-results', `run-${process.pid}`),
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
  // 经 `pnpm test:e2e` 时由 runner 自己拉起并持有 webServer，取消时才能连它一起收掉；
  // 只有直接跑 playwright 时这里才代为启动。
  webServer: process.env.CI_TEST_EXTERNAL_WEBSERVER === '1'
    ? undefined
    : {
        command: 'node scripts/ci/browser-server.mjs',
        url: `${env.probeOrigin}/__e2e/ready`,
        reuseExistingServer: false,
        timeout: 35_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 6_000 },
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
