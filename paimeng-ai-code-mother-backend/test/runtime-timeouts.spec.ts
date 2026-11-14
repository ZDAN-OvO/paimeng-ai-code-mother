import { afterEach, describe, expect, it } from 'vitest'
import { AppConfigService } from '../src/config/config.module'

const KEYS = [
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_CONTEXT_WINDOW_TOKENS',
  'INSTALL_TIMEOUT_MS',
  'BUILD_TIMEOUT_MS',
  'PREVIEW_START_TIMEOUT_MS',
  'DISK_RESERVE_BYTES',
]

const original = new Map(KEYS.map((key) => [key, process.env[key]]))

function setBaseEnv() {
  process.env.SESSION_SECRET = 'x'.repeat(32)
  process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/test'
  process.env.REDIS_URL = 'redis://127.0.0.1:6379'
  process.env.AI_BASE_URL = 'http://127.0.0.1:3425/v1'
  process.env.AI_MODEL = 'test-model'
  process.env.AI_CONTEXT_WINDOW_TOKENS = '10000'
  delete process.env.INSTALL_TIMEOUT_MS
  delete process.env.BUILD_TIMEOUT_MS
  delete process.env.PREVIEW_START_TIMEOUT_MS
  delete process.env.DISK_RESERVE_BYTES
}

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('runtime timeout configuration', () => {
  it('uses the planned 5m/3m/60s defaults', () => {
    setBaseEnv()
    const config = new AppConfigService()
    expect(config.installTimeoutMs).toBe(5 * 60 * 1000)
    expect(config.buildTimeoutMs).toBe(3 * 60 * 1000)
    expect(config.previewStartTimeoutMs).toBe(60 * 1000)
    expect(config.diskReserveBytes).toBe(2 * 1024 * 1024 * 1024)
  })

  it('allows each timeout to be overridden', () => {
    setBaseEnv()
    process.env.INSTALL_TIMEOUT_MS = '1200'
    process.env.BUILD_TIMEOUT_MS = '2300'
    process.env.PREVIEW_START_TIMEOUT_MS = '3400'
    const config = new AppConfigService()
    expect(config.installTimeoutMs).toBe(1200)
    expect(config.buildTimeoutMs).toBe(2300)
    expect(config.previewStartTimeoutMs).toBe(3400)
  })
})
