import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { freePorts } from '../../scripts/ci/services.mjs'
import { finishLifecycle, preserveRuntimeEvidence, readLifecycle } from '../../scripts/verify/evidence.mjs'

test('Docker loss during cleanup retains the triggering failure and writes lifecycle evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paimeng-evidence-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const [web, backend, model] = await freePorts(3)
  const original = new Error('browser journey failed first')
  const lifecycle = { ready: true, cleanup: null }
  const returned = await finishLifecycle(
    directory,
    lifecycle,
    {
      token: 'this-run-only',
      env: {
        CI_TEST_WEB_PORT: web,
        CI_TEST_BACKEND_PORT: backend,
        CI_TEST_MODEL_PORT: model,
        CI_TEST_WORK_DIR: join(directory, 'already-removed'),
      },
    },
    original,
    () => {
      throw new Error('Docker daemon unavailable')
    },
  )
  assert.equal(returned, original)
  const saved = await readLifecycle(directory)
  assert.equal(saved.error, original.message)
  assert.deepEqual(saved.cleanup, { portsClosed: true, workRemoved: true, containersGone: false })
  assert.deepEqual(saved.cleanupErrors, ['docker: Docker daemon unavailable'])
})

test('outer cleanup preserves backend and Docker audit files without Playwright teardown', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'paimeng-work-test-'))
  const evidence = await mkdtemp(join(tmpdir(), 'paimeng-proof-test-'))
  t.after(() => Promise.all([work, evidence].map((path) => rm(path, { recursive: true, force: true }))))
  await writeFile(join(work, 'browser-backend.log'), 'run interrupted\n')
  await writeFile(join(work, 'docker-calls.log'), 'network inspect paimeng-apps\n')
  await preserveRuntimeEvidence(work, evidence)
  await rm(work, { recursive: true })
  assert.equal(await readFile(join(evidence, 'browser-backend.log'), 'utf8'), 'run interrupted\n')
  assert.equal(await readFile(join(evidence, 'docker-calls.log'), 'utf8'), 'network inspect paimeng-apps\n')
})
