import assert from 'node:assert/strict'

// No fallback, dotenv, or production configuration is allowed at this boundary.
export function isolatedConnections() {
  assert.equal(process.env.CI_TEST_ISOLATED, '1', 'CI_TEST_ISOLATED=1 is required')
  const parse = (value, name, protocols) => {
    assert.ok(value, `${name} is required`)
    let url
    try {
      url = new URL(value)
    } catch {
      assert.fail(`${name} must be a valid URL`)
    }
    assert.ok(protocols.includes(url.protocol), `${name}: unsupported protocol`)
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), `${name}: loopback only`)
    // Query parameters can override pg's host/database/options; reject all of them.
    assert.equal(url.search, '', `${name}: query parameters are forbidden`)
    assert.equal(url.hash, '', `${name}: fragments are forbidden`)
    return url
  }
  const pg = parse(process.env.CI_TEST_DATABASE_URL, 'CI_TEST_DATABASE_URL', ['postgres:', 'postgresql:'])
  assert.match(pg.pathname, /^\/paimeng_ci_[A-Za-z0-9_]+$/, 'PostgreSQL database must start with paimeng_ci_')
  const redis = parse(process.env.CI_TEST_REDIS_URL, 'CI_TEST_REDIS_URL', ['redis:'])
  assert.equal(redis.pathname, '/15', 'Redis database must be exactly DB15')
  // Bound queries and abandoned transactions even when a test assertion fails.
  pg.searchParams.set(
    'options',
    '-c statement_timeout=10000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=10000',
  )
  return { databaseUrl: pg.href, redisUrl: redis.href }
}
