import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('cancellation during cleanup fails the lifecycle and preserves any earlier failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paimeng-evidence-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const evidenceModule = new URL('../../scripts/verify/evidence.mjs', import.meta.url).href
  const script = `
    import { finishLifecycle } from ${JSON.stringify(evidenceModule)}
    const [directory, original] = process.argv.slice(1)
    const lifecycle = { ready: true, cleanup: null }
    const failure = await finishLifecycle(directory, lifecycle, {
      token: 'this-run-only',
      env: {
        CI_TEST_WEB_PORT: 0,
        CI_TEST_BACKEND_PORT: 0,
        CI_TEST_MODEL_PORT: 0,
        CI_TEST_WORK_DIR: directory + '/already-removed',
      },
    }, original ? new Error(original) : undefined, () => {
      process.emit('SIGTERM')
      return ''
    })
    if (failure) process.exitCode = 1
  `
  for (const original of ['', 'browser journey failed first']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory, original], {
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(child.status, 1, child.error?.message ?? child.stderr)
    const saved = await readLifecycle(directory)
    assert.equal(saved.error, original || 'CI interrupted by SIGTERM')
    assert.equal(saved.interruption, 'CI interrupted by SIGTERM')
    assert.deepEqual(saved.cleanup, { portsClosed: true, workRemoved: true, containersGone: true })
  }
})

test('cancellation after lifecycle success still fails the final verify manifest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paimeng-manifest-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const evidenceModule = new URL('../../scripts/verify/evidence.mjs', import.meta.url).href
  const script = `
    import { writeManifest } from ${JSON.stringify(evidenceModule)}
    const [directory, original] = process.argv.slice(1)
    const report = original ? { ok: false, error: original } : { ok: true }
    process.emit('SIGTERM')
    writeManifest(directory, report)
    if (!report.ok) process.exitCode = 1
  `
  for (const original of ['', 'artifact verification failed first']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory, original], {
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(child.status, 1, child.error?.message ?? child.stderr)
    const saved = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    assert.equal(saved.ok, false)
    assert.equal(saved.error, original || 'CI interrupted by SIGTERM')
    assert.equal(saved.interruption, 'CI interrupted by SIGTERM')
  }
})
