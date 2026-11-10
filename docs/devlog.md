# 开发日志

每片的先红后绿证据、CI 失败、审查发现、用户打回原话、采用/放弃与原因、对应 SHA/PR/产物都记在这里。任务状态以 [`slices.json`](slices.json) 为准，本文件记过程与决定。计划见私有 `local/plans/mvp-multi-agent-execution.md`，不随仓库公开。

## P0 交付流程试跑（2026-11-10）

### 起点

- 分支 `feat/p0-pr-gate`，前一轮已有一个未开 PR 的提交，基线 `1db769b`；本次 rebase 到当时主干 `a90d42f`（P0 的 `base_sha`）。
- 前一轮的门禁实现保留：`scripts/pr-gate/gate.ts`（可单测的判定）、`scripts/pr-gate.ts`（CLI）、`scripts/pr-gate/gate.test.ts`。本次没有重写这些文件的历史，只补缺口并重跑全部检查。
- 上一版 `docs/slices.json` 还是旧计划的切片（P1a/P1b/P2a 等 spike 与骨架任务）。已按批准计划重写为 P0 + P1 首片，远期只留阶段目标。
- 私有材料（`local/reqs/`、`local/briefs/`、`local/plans/`、`local/spikes/`）由 `.gitignore` 排除，不进公开提交。

### 本次改动

| 改动                                              | 原因                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `scripts/pr-gate.ts` 读报告失败时给出明确拒绝原因 | 原来文件缺失或 JSON 损坏会抛栈退出：虽然失败关闭，但看不出是哪个输入坏了 |
| 新增 `scripts/pr-gate/cli.test.ts`                | 原测试只覆盖纯函数，没有验证参数解析、文件读取与退出码                   |
| `docs/slices.json` 按批准计划重写                 | 旧清单来自已废弃的排程                                                   |
| CI 迁移测试库改为 `paimeng_test`                  | 计划要求迁移在独立 `_test` 库上跑，不占开发库名                          |

### 先红后绿

- 红：新增 `cli.test.ts` 后运行 `vitest run scripts/pr-gate/cli.test.ts` → `Tests 2 failed | 2 passed`；失败项是“报告文件不存在”和“JSON 损坏”，实际输出是 Node 的 `ENOENT` / `SyntaxError` 堆栈，没有 `拒绝开 PR`。
- 绿：`scripts/pr-gate.ts` 改为把读取错误并入拒绝原因后 → `vitest run scripts/pr-gate` 全部 `Tests 11 passed (11)`（7 个判定用例 + 4 个入口用例）。
- 入口用例覆盖：全一致放行、报告文件缺失、报告 JSON 损坏、缺 completion review 参数。

### 全量本地检查

- `npm run lint`、`npm run type-check`：无输出，退出 0。
- `npm test`：`Test Files 7 passed (7)`、`Tests 25 passed (25)`（含 pr-gate 的 11 项）。
- `npm run check:docs`：`证据：通过 1 · 过期 0 · 未检 22`，`docs check ok`。
- `npm run format:check`：`All matched files use Prettier code style!`。
- `npm run build`：Next 构建完成，退出 0。
- 真实拒绝路径（不只看单测）：不传任何报告运行 `npm run pr:gate -- --remote <sha>` 得到 `pr-gate: 拒绝开 PR`，逐条列出缺少 CI 与两份报告。

### 门禁、审查与 PR

（本节在 CI、两次审查和开 PR 后补：候选提交 SHA、CI 运行链接、两份报告与打回原因、实际耗时。）

### 偏离计划的地方

- 计划写 `scripts/pr-gate.mjs`，实际为 `scripts/pr-gate/gate.ts`（判定逻辑，可单测）加 `scripts/pr-gate.ts`（CLI，`npm run pr:gate`，用已装的 `tsx` 执行）。拆两个文件是为了 CLI 被 import 时不执行；`vitest.config.mts` 的 include 相应加入 `scripts/**/*.test.ts`。
- 本轮没有产品页面变化，按计划不为展示生成 GIF。
