import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { eq, is } from 'drizzle-orm'
import * as schema from '../../dist/db/schema.js'
import { assistantMessage } from '../../dist/conversations/types.js'
import { TEST_TIMEOUT, bounded, outcome, waitForBlocked, withHarness } from './support.mjs'

const options = { timeout: TEST_TIMEOUT }

test('empty-database migration replay matches the built schema and migration ledger', options, async () => {
  await withHarness(async ({ db }) => {
    const journal = JSON.parse(
      await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    )
    const expected = await Promise.all(
      journal.entries.map(async (entry) => ({
        hash: createHash('sha256')
          .update(await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'))
          .digest('hex'),
        created_at: String(entry.when),
      })),
    )
    const { rows: ledger } = await db.pool.query(
      'select hash, created_at::text from drizzle.__drizzle_migrations order by id',
    )
    assert.deepEqual(ledger, expected, 'Runner must replay all committed migrations before the tests')

    const tables = Object.values(schema).filter((value) => is(value, PgTable))
    assert.ok(tables.length > 0, 'The built schema must export real PostgreSQL tables')
    for (const table of tables) {
      const config = getTableConfig(table)
      const { rows: columns } = await db.pool.query(
        `select column_name, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [config.name],
      )
      assert.deepEqual(
        columns.map((column) => column.column_name).sort(),
        config.columns.map((column) => column.name).sort(),
        config.name,
      )
      for (const column of config.columns) {
        const actual = columns.find((entry) => entry.column_name === column.name)
        assert.equal(
          actual.is_nullable,
          column.notNull ? 'NO' : 'YES',
          `${config.name}.${column.name} nullability`,
        )
        if (column.hasDefault)
          assert.notEqual(actual.column_default, null, `${config.name}.${column.name} default`)
      }
      const { rows: indexes } = await db.pool.query(
        `select c.relname as name, i.indisunique as unique, i.indisvalid as valid,
                pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i join pg_class c on c.oid = i.indexrelid
         where i.indrelid = $1::regclass`,
        [`public.${config.name}`],
      )
      for (const index of config.indexes) {
        const actual = indexes.find((entry) => entry.name === index.config.name)
        assert.ok(actual, `Missing migrated index ${index.config.name}`)
        assert.equal(actual.valid, true)
        assert.equal(actual.unique, index.config.unique)
        assert.equal(actual.predicate !== null, Boolean(index.config.where))
      }
      const { rows: foreignKeys } = await db.pool.query(
        `select conname, confdeltype from pg_constraint where conrelid = $1::regclass and contype = 'f'`,
        [`public.${config.name}`],
      )
      for (const foreignKey of config.foreignKeys) {
        const actual = foreignKeys.find((entry) => entry.conname === foreignKey.getName())
        assert.ok(actual, `Missing foreign key ${foreignKey.getName()}`)
        assert.equal(actual.confdeltype, foreignKey.onDelete === 'cascade' ? 'c' : 'n')
      }
    }
  })
})

async function competingInsert(db, fixture, firstStatus, secondStatus, sameRequest, constraint) {
  const first = await db.pool.connect()
  const second = await db.pool.connect()
  let pending
  try {
    const {
      rows: [{ pid }],
    } = await first.query('select pg_backend_pid() as pid')
    await first.query('begin')
    await second.query('begin')
    const requestId = randomUUID()
    const insert = `insert into agent_runs (app_id, conversation_id, client_request_id, status, deadline_at)
                    values ($1, $2, $3, $4, now() + interval '1 minute') returning id`
    await first.query(insert, [fixture.appId, fixture.conversationId, requestId, firstStatus])
    pending = second
      .query(insert, [
        fixture.appId,
        fixture.conversationId,
        sameRequest ? requestId : randomUUID(),
        secondStatus,
      ])
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
    await waitForBlocked(db.pool, pid)
    await first.query('commit')
    const result = await bounded(pending, 'Competing unique insert')
    assert.equal(result.error?.code, '23505', 'Exactly the conflicting insert must fail')
    assert.equal(result.error.constraint, constraint)
    await second.query('rollback')
    const { rows } = await db.pool.query('select id from agent_runs where app_id = $1', [fixture.appId])
    assert.equal(rows.length, 1, 'The winning transaction must really persist')
  } finally {
    await first.query('rollback')
    await second.query('rollback')
    if (pending) await pending
    first.release()
    second.release()
  }
}

for (const status of ['running', 'cancelling']) {
  test(
    `partial unique index blocks a concurrent active run when existing status is ${status}`,
    options,
    async () => {
      await withHarness(async ({ db, fixture }) => {
        await competingInsert(db, await fixture(), status, 'running', false, 'runs_one_active_per_app_uq')
      })
    },
  )
}

test('request-id unique index rejects concurrent duplicate terminal runs per app', options, async () => {
  await withHarness(async ({ db, fixture }) => {
    await competingInsert(db, await fixture(), 'completed', 'failed', true, 'runs_app_client_request_uq')
  })
})

test(
  'public startRun persists one complete transaction for concurrent identical requests',
  options,
  async () => {
    await withHarness(async ({ db, fixture, runs, queue, started, finish }) => {
      const app = await fixture()
      const requestId = randomUUID()
      const results = await bounded(
        Promise.all(
          Array.from({ length: 8 }, () => runs.startRun(app.userId, app.appId, 'build a page', requestId)),
        ),
        'Concurrent public startRun',
        10_000,
      )
      assert.equal(new Set(results.map((result) => result.runId)).size, 1)
      const runId = results[0].runId
      await started(runId)
      const { rows: runRows } = await db.pool.query('select * from agent_runs where app_id = $1', [app.appId])
      assert.equal(runRows.length, 1)
      assert.equal(runRows[0].status, 'running')
      const { rows: messageRows } = await db.pool.query(
        'select role, status from messages where run_id = $1 order by id',
        [runId],
      )
      assert.deepEqual(messageRows, [
        { role: 'user', status: 'completed' },
        { role: 'assistant', status: 'streaming' },
      ])
      const { rows: entries } = await db.pool.query(
        'select seq, entry_type, payload from agent_session_entries where run_id = $1',
        [runId],
      )
      assert.deepEqual(entries, [{ seq: 1, entry_type: 'user', payload: { text: 'build a page' } }])
      await assert.rejects(runs.startRun(app.userId, app.appId, 'different content', requestId), {
        status: 409,
      })
      assert.equal((await queue.allItems(app.appId)).length, 1)
      await finish(runId)
      assert.deepEqual(await runs.startRun(app.userId, app.appId, 'build a page', requestId), {
        runId,
        reused: true,
      })
      assert.equal((await runs.getRunStatus(app.userId, { runId })).status, 'completed')
    })
  },
)

test(
  'two public starts remain running; the worker rejects a third app at MAX_RUNS_PER_USER=2',
  options,
  async () => {
    await withHarness(async ({ db, fixture, runs, config, started, finish }) => {
      const first = await fixture()
      const second = await fixture(first.userId)
      const third = await fixture(first.userId)
      const results = await Promise.all(
        [first, second].map((app) => runs.startRun(app.userId, app.appId, 'keep running', randomUUID())),
      )
      await Promise.all(results.map((result) => started(result.runId)))
      const count = async () =>
        Number(
          (
            await db.pool.query(
              `select count(*) as count from agent_runs r join apps a on a.id = r.app_id
       where a.owner_id = $1 and r.status in ('running', 'cancelling')`,
              [first.userId],
            )
          ).rows[0].count,
        )
      assert.equal(await count(), config.maxRunsPerUser, 'The quota must actually be filled')
      // Public startRun waits in the queue when the worker hits the quota; the worker
      // boundary exposes its real 409 without replacing dispatch/SQL with a mock.
      await assert.rejects(
        runs.startQueuedRun(third.userId, third.appId, 'over quota', randomUUID()),
        (error) => {
          assert.equal(error.status, 409)
          assert.match(error.message, /同时运行的应用已达上限/)
          return true
        },
      )
      assert.equal(await count(), 2)
      for (const table of ['agent_runs', 'messages', 'agent_session_entries']) {
        const column = table === 'agent_runs' ? 'app_id' : 'conversation_id'
        const id = table === 'agent_runs' ? third.appId : third.conversationId
        assert.equal(
          Number(
            (await db.pool.query(`select count(*) as count from ${table} where ${column} = $1`, [id])).rows[0]
              .count,
          ),
          0,
        )
      }
      // Capacity is freed by a real completion, and the previously rejected app can run.
      await finish(results[0].runId)
      const next = await runs.startRun(third.userId, third.appId, 'after capacity freed', randomUUID())
      await started(next.runId)
      assert.equal(await count(), 2)
    })
  },
)

test(
  'startRun worker rolls back messages and run when final session sequencing fails in PostgreSQL',
  options,
  async () => {
    await withHarness(async ({ db, fixture, runs, queue }) => {
      const app = await fixture()
      // A real integer overflow computing the last session sequence follows both messages and run.
      // This sentinel is ours; no schema changes or global fault injection are needed.
      await db.db.insert(schema.agentSessionEntries).values({
        conversationId: app.conversationId,
        runId: randomUUID(),
        seq: 2147483647,
        entryType: 'user',
        payload: { text: 'rollback sentinel' },
      })
      await assert.rejects(
        runs.startQueuedRun(app.userId, app.appId, 'must roll back', randomUUID()),
        (error) => {
          assert.equal(error.cause?.code ?? error.code, '22003')
          return true
        },
      )
      assert.equal(
        (await db.pool.query('select id from agent_runs where app_id = $1', [app.appId])).rowCount,
        0,
      )
      assert.equal(
        (await db.pool.query('select id from messages where conversation_id = $1', [app.conversationId]))
          .rowCount,
        0,
      )
      assert.equal(
        (
          await db.pool.query('select seq from agent_session_entries where conversation_id = $1', [
            app.conversationId,
          ])
        ).rows[0].seq,
        2147483647,
      )
      assert.deepEqual(await queue.snapshot(app.appId), { paused: false, activeRun: null, items: [] })
    })
  },
)

test('SessionStore rolls back a steer insert if its assistant message already ended', options, async () => {
  await withHarness(async ({ db, fixture, seedRun, sessions }) => {
    const app = await fixture()
    const run = await seedRun(app)
    await db.pool.query("update messages set status = 'completed' where run_id = $1 and role = 'assistant'", [
      run.id,
    ])
    const steers = [{ clientRequestId: randomUUID(), message: 'must not be consumed' }]
    await assert.rejects(
      sessions.appendSteers(app.conversationId, run.id, steers, assistantMessage(run.id)),
      { status: 409 },
    )
    assert.equal((await sessions.list(app.conversationId)).length, 0)
    await db.pool.query("update messages set status = 'streaming' where run_id = $1 and role = 'assistant'", [
      run.id,
    ])
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sessions.appendSteers(app.conversationId, run.id, steers, assistantMessage(run.id)),
      ),
    )
    const entries = await sessions.list(app.conversationId)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].payload.steerRequestId, steers[0].clientRequestId)
  })
})

test(
  'finalize waits for the run row lock and respects cancellation committed by the lock holder',
  options,
  async () => {
    await withHarness(async ({ db, fixture, seedRun, runs, queue }) => {
      const app = await fixture()
      const run = await seedRun(app)
      const lock = await db.pool.connect()
      let pending
      try {
        await lock.query('begin')
        const {
          rows: [{ pid }],
        } = await lock.query('select pg_backend_pid() as pid')
        await lock.query("update agent_runs set status = 'cancelling' where id = $1", [run.id])
        pending = runs.finalize(run.id, outcome()).then(
          () => ({}),
          (error) => ({ error }),
        )
        await waitForBlocked(db.pool, pid)
        await lock.query('commit')
        assert.deepEqual(await bounded(pending, 'Locked finalization'), {})
      } finally {
        await lock.query('rollback')
        if (pending) await pending
        lock.release()
      }
      const status = await runs.getRunStatus(app.userId, { runId: run.id })
      assert.equal(status.status, 'cancelled')
      assert.equal(status.errorCode, 'CANCELLED')
      const {
        rows: [assistant],
      } = await db.pool.query("select status from messages where run_id = $1 and role = 'assistant'", [
        run.id,
      ])
      assert.equal(assistant.status, 'cancelled')
      assert.deepEqual(await queue.snapshot(app.appId), { paused: true, activeRun: null, items: [] })
    })
  },
)

test(
  'independent finalizers persist exactly one matching terminal outcome and activity',
  options,
  async () => {
    await withHarness(async ({ db, fixture, seedRun, runs, peerRuns, queue }) => {
      const app = await fixture()
      const run = await seedRun(app)
      await Promise.all([
        runs.finalize(run.id, outcome('completed', 'winner completed')),
        peerRuns.finalize(run.id, outcome('failed', 'winner failed')),
      ])
      const [row] = await db.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id))
      assert.ok(['completed', 'failed'].includes(row.status))
      const {
        rows: [message],
      } = await db.pool.query(
        "select status, content from messages where run_id = $1 and role = 'assistant'",
        [run.id],
      )
      assert.equal(message.status, row.status)
      assert.equal(message.content.parts[0].text, `winner ${row.status}`)
      const { rows: activities } = await db.pool.query(
        "select payload from run_activities where run_id = $1 and type = 'run-finished'",
        [run.id],
      )
      assert.equal(activities.length, 1)
      assert.equal(activities[0].payload.status, row.status)
      const before = JSON.stringify(row)
      await peerRuns.finalize(run.id, outcome('cancelled', 'late duplicate'))
      const [after] = await db.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id))
      assert.equal(JSON.stringify(after), before, 'Late finalization cannot overwrite the terminal row')
      const snapshot = await queue.snapshot(app.appId)
      assert.equal(snapshot.activeRun, null)
      assert.equal(snapshot.paused, row.status !== 'completed')
    })
  },
)

test('cancelRun crosses real PostgreSQL and Redis and returns only unconsumed steers', options, async () => {
  await withHarness(async ({ db, fixture, seedRun, runs, queue, sessions, stopped }) => {
    const app = await fixture()
    const run = await seedRun(app)
    const consumed = await queue.enqueue(app.appId, {
      clientRequestId: randomUUID(),
      message: 'consumed',
      mode: 'steer',
      runId: run.id,
    })
    const returned = await queue.enqueue(app.appId, {
      clientRequestId: randomUUID(),
      message: 'unconsumed',
      mode: 'steer',
      runId: run.id,
    })
    await queue.claimSteers(app.appId, run.id)
    await sessions.appendSteers(app.conversationId, run.id, [consumed], assistantMessage(run.id))
    await runs.cancelRun(app.userId, run.id)
    const status = await runs.getRunStatus(app.userId, { runId: run.id })
    assert.equal(status.status, 'cancelled')
    assert.deepEqual(stopped, [app.appId])
    const items = await queue.allItems(app.appId)
    assert.equal(items.find((item) => item.id === consumed.id).status, 'applied')
    assert.equal(items.find((item) => item.id === returned.id).status, 'returned')
    assert.equal((await queue.snapshot(app.appId)).paused, true)
    const {
      rows: [row],
    } = await db.pool.query('select cancel_requested_at, finished_at from agent_runs where id = $1', [run.id])
    assert.ok(row.cancel_requested_at && row.finished_at)
    await runs.cancelRun(app.userId, run.id)
    assert.equal(stopped.length, 1, 'Cancelling a terminal run does not stop the runtime again')
  })
})
