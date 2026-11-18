import assert from 'node:assert/strict'
import { test } from 'node:test'
import { featureFiles } from '../../scripts/verify/features.mjs'
import PhaseReporter, { browserTestsStarted } from '../e2e/phase-reporter.mjs'

test('verify all explicitly selects the five feature specs', () => {
  assert.deepEqual(featureFiles('all'), [
    'tests/e2e/generation.spec.mjs',
    'tests/e2e/access.spec.mjs',
    'tests/e2e/steer.spec.mjs',
    'tests/e2e/cancellation.spec.mjs',
    'tests/e2e/recovery.spec.mjs',
  ])
})

test('the browser phase marker is emitted only when the first test starts', (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const reporter = new PhaseReporter()
  assert.equal(log.mock.callCount(), 0)
  reporter.onTestBegin()
  reporter.onTestBegin()
  assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args), [[browserTestsStarted]])
})
