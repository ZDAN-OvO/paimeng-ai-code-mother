# 开发日志

每片的先红后绿证据、CI 失败、审查发现、用户打回原话、采用/放弃与原因、对应 SHA/PR/产物都记在这里。任务状态以 [`slices.json`](slices.json) 为准，本文件记过程与决定。

## P0 基线与门禁（2026-11-09）

- 分支 `feat/p0-pr-gate`，从 `origin/main`（`1db769b`）分出。
- 执行前 pre-mortem（reviewer，`xhy-api/gpt-6.1-sol`）判 BLOCK，要求先补三条启动约定：私有材料边界、清单写回规则、前置条件顺序。三条已写进计划；技术路线未改。
- 私有材料：`local/briefs/`、`local/reqs/` 与 `docs/plans/mvp-multi-agent-execution.md` 由 `.git/info/exclude` 排除，不进公开提交。
- 范围：`scripts/pr-gate/`（判定逻辑与单测）、`scripts/pr-gate.ts`（CLI）、`docs/slices.json`、`.github/workflows/tests.yml` 补 `check:docs` 与完整历史检出。无界面，PR 中说明原因。

（本节在 P0 完成时补：失败测试输出、实现后的通过输出、CI 结果、两次审查结论与打回原因。）

### 先红后绿

- 红：`npx vitest run scripts/pr-gate` → `Test Files 1 failed (1)`，原因是 `gate.ts` 不存在，导入失败（`scripts/pr-gate/gate.test.ts:2`）。
- 绿：实现 `scripts/pr-gate/gate.ts` 后 → `Tests 7 passed (7)`。单测覆盖：全一致放行、CI 未通过、CI 跑在别的提交、缺 completion review、review 的 SHA 过期、review 结论为打回、远端提交不一致。
- 全量本地检查：`lint`、`type-check`、`format:check`、`test`（21 passed）、`check:docs`（通过 1 / 过期 0 / 未检 22）、`build` 均通过。

### 偏离计划的地方

- 计划写 `scripts/pr-gate.mjs`，实际是 `scripts/pr-gate/gate.ts`（判定逻辑，可单测）加 `scripts/pr-gate.ts`（CLI，走 `npm run pr:gate`，用已装的 `tsx` 执行）。拆成两个文件是为了让 CLI 不在被 import 时执行，避开入口判断的已知坑。
- `vitest.config.mts` 的 include 增加 `scripts/**/*.test.ts`，否则新测试不会被收集。
