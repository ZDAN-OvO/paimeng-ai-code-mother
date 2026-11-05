<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

The layout below is navigation, not a spec: commands, schemas and test names still live in the code. Only invariants that are not obvious from the source, scripts or tests belong in the sections after it.

## Layout

```
paimeng-ai-code-agent/
├── AGENTS.md          # this file: layout + invariants
├── src/
│   ├── app/           # App Router pages and HTTP entries: api/[...path] business dispatch, api/durable harness attach/SSE
│   ├── server/        # Node domain modules; see src/server/AGENTS.md
│   ├── components/    # React UI the pages compose
│   ├── shared/        # zod contracts and types imported by both sides
│   └── client/        # browser API client and response envelope
├── templates/         # versioned skeletons copied into new apps: html, multi-file, react-ts, vue-ts
├── config/            # runtime-read policy files (input guardrail rules); env override in .env.example
├── migrations/        # SQL; applied files are immutable history
├── tests/             # suites split by allowed resources; see tests/AGENTS.md
├── evals/             # generation-quality datasets, rubric and evidence scripts; see evals/AGENTS.md
├── scripts/           # reusable entry points only; prerequisites, ports, rules in scripts/AGENTS.md
├── docs/              # contracts, ADRs, plans, prototypes; placement rules in docs/AGENTS.md
├── runtime/           # local runtime data, never source
└── public/            # static assets
```

## Read next

- Run it, prerequisites, ports: `scripts/AGENTS.md`
- Generation quality evals: `evals/AGENTS.md`
- Server module boundaries: `src/server/AGENTS.md`
- Cross-module invariants: `docs/implementation-contract.md`

## UI

- A named `Form.Item` must receive its control directly. Wrapping it in `Space`, `Space.Compact`, `div`, or similar drops antd's injected `value`/`onChange`; the UI can still look correct while nothing persists. Keep buttons and hints outside the item.
- Do not use `{' '}` as spacing inside `Form.Item`; it turns the child list into multiple nodes and breaks binding. Use layout spacing instead.
- antd v6 deprecations warn only in development builds. A passing production E2E run is not evidence that they are absent.

## Scope and data

- The repository-root `archive/` Java and Vue code is read-only reference material.
- End-to-end evidence uses the running development app and its real databases. The Vitest integration harness resets storage and must stay on the isolated `_test` databases; never point a resetting suite at the development databases.

## Rules and what enforces them

Each rule names its enforcer. A row with none is where the next repeat lands: give that rule an enforcer first, then delete the note.

| Rule | Enforcer |
| --- | --- |
| antd v6 deprecated props (`Space direction`, `Input addonAfter/addonBefore`, `Drawer width`) | `npm run check:ui`; the table lives in `scripts/lib/ui-patterns.ts` as `antdDeprecatedProps` |
| A named `Form.Item` binds its control directly | Same check, `formItemWiringViolations` |
| E2E specs use no hard-coded origins, no `role=option/alert` locators, no hand-built evidence paths | `npm run check:e2e` |
| A new test script states which pipeline runs it | `npm run check:ci`; the table is `scripts/verify/check-ci-coverage.ts` |
| Unit tests start no services and open no databases | `tests/support/unit-boundaries.ts`, refused at run time |
| Nothing uncommitted outside the product directory | `npm run verify:boundary` |
| A shared shape is declared once, by its schema | Type derivation: `SlotSettingsValues` is a mapped type over `ModelAliasSettings`, capability fields are annotated `ModelAliasCapabilities`; adding a schema field breaks compilation |
| No state survives an account switch or logout | `AuthContext.sessionKey` plus `Layout.Content key`; covered by `tests/e2e/react-page-lifecycle.spec.ts`, which runs only when E2E is run by hand |
| A late response cannot overwrite newer state | Per-component sequence numbers and live flags. **No E2E for the edit page**: while a save awaits its refresh the submit control is disabled, so the second save that would race never happens; see the spec header before re-adding one |
| The client validates response payloads | **None.** `api<T>` validates the envelope only and 45 call sites assert with `as T`. This needs a response schema registry; see the PR body |
| Integration and E2E run on pull requests | **None.** Pull requests run unit tests and static checks only; see the table in `scripts/verify/check-ci-coverage.ts` |
