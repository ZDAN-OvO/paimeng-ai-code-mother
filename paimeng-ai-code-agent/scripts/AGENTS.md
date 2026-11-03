# scripts/

Reusable entry points only. A script earns its place by being referenced from `package.json`, CI, tests or a current doc; one-off scripts are deleted after they run, never archived.

## Layout

```
scripts/
├── AGENTS.md   # this file: prerequisites, entry points, rules
├── dev/        # dev-stop, durable-dev, preview: local processes and the preview server
├── db/         # migrate, test-database, initialize-models, admin, pending legacy import
├── verify/     # ui/e2e pattern checks, boundary check, infra + restart acceptance, isolated e2e launcher
├── ops/        # infra up, durable-pg, durable-inspect
└── hooks/      # pre-commit, pre-push; the repo .git/config points hooksPath here
```

## Prerequisites

- Node 24.15+, npm, a running Docker daemon, a Linux host that can run a Chromium sandbox.
- `cp .env.example .env`. It already carries `DATABASE_URL`, `DURABLE_PG_URL` and `REDIS_URL` for local use; real model credentials are not in it.
- Postgres is **not** managed by this repo: `compose.yaml` has only mysql and redis. `npm run durable:pg` connects to the local `zslm-postgres` container (127.0.0.1:5432), creates the missing databases and prints versions — it never starts, stops or clears a container, so that container must already be running.
- One instance, four databases: `paimeng_app` + `paimeng_agent` for development, `paimeng_app_test` + `paimeng_agent_test` for integration tests (the resetting harness must stay on the `_test` pair).
- `npm run infra:up` brings up Redis (fixed container name, health-checked) from `.env`.
- `docker pull node:24-alpine` for isolated Vue builds; `npx playwright install chromium` for cover captures and browser tests.
- Resetting harness verification requires an explicitly provisioned exclusive storage database, `DURABLE_PG_URL=postgres://…/paimeng_agent_<run>_test`; all query options are rejected. Integration and isolated E2E preserve that database name. They refuse to reset shared `paimeng_agent_test` or development storage. The storage isolation integration test additionally uses the corresponding `<run>_witness_test` database. Provision only missing databases; never reuse another run's active storage or clear shared tables.
- Ports: 3000 platform, 3001 preview (separate hostname, not an admin UI), 5599 resident pi-durable harness.

## Entry points

- Dev and processes: `dev` (harness + preview + Next, Ctrl-C stops all), `dev:stop` (process-group cleanup for a leftover launcher), `dev:web`, `preview`, `durable:harness`, `durable:pg`, `infra:up`, `infra:status`, `infra:stop`, `hooks:install`
- Database: `db:migrate`, `db:test:setup`, `db:init-models`, `db:backfill-model-config`, `db:admin -- <account>`
- Verify and quality: `check:ui`, `check:e2e`, `check:fast`, `verify:boundary`, `verify:infra`, `verify:restart`, `test:e2e:isolated`, `test:all`
- Diagnose: `durable:inspect`

All of them run from `paimeng-ai-code-agent/`, not the repo root.

## Rules

1. **Entry points only.** A new script must be referenced by `package.json`, CI, tests or a current doc. No caller means it does not belong here.
2. **One-off scripts are deleted after they run.** Migration, backfill, historic comparison and data-repair scripts go away once verified — the file, its `package.json` command and the doc references together. Never move them to `archive/`, never keep them behind a "might need it later" comment.
3. **Pending one-off scripts are listed explicitly.** Only while their plan is open; today that is the legacy-import entries and model-config backfill. Delete them once the switch is done.
4. **Group by purpose.** Entry points in `dev/`, `db/`, `verify/`, `ops/`; shared implementation in `lib/`; Git hooks in `hooks/`. Shared logic is not copied between entry points.
5. **Safe by default.** Migrations and backfills dry-run unless `--apply` is passed, and each script validates its own target database instead of trusting the caller.

## Pending one-off scripts

Kept only until the production switch in `docs/plans/legacy-import.md` finishes, then deleted under rule 2:

- `npm run db:import -- <snapshot>` — import a reviewed JSON copy of old users and apps, optionally copying legacy artifacts.
- `npm run legacy:import -- --runtime <copy>` — import old previews and unpublished drafts into the new delivery/draft control plane.

Kept while the model-config switch in `docs/plans/provider-model-billing.md` is pending:

- `npm run db:backfill-model-config` — dry-run the legacy model tables and rate cards into `app_config`; add `-- --apply` to commit under a row lock. Requires migration 023 and a dedicated app database. Reports contain counts, UTF-8 document bytes, conflict messages, and zero-based orphan rate row positions (ordered by provider ID, model name, effective time); configuration values are never printed. Remove this tool after the switch is verified.

## Already removed

The brand-image import and the old-UI comparison scripts ran and were deleted, as was the version backfill/migration entry when that plan archived. To replay what they did, read the archived plan and `git log`; do not restore them as everyday entry points.
