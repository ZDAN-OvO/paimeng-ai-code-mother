# Brief: 文档与代码一致，且每条结论都有可复现证据

- Stage: execute
- Source: 交叉核对前端、docs/mvp.md、docs/architecture.md 是否一致；复述为「核实三份设计文档与代码是否一致，并持续由 agent 维护，每个修复和做成、错误和做不成，都要有可以复现的证据」

## Goal

- 让接手的人（下一次会话的 agent、写 `src/server/**` 的你）不看作者自述，就能判断 `docs/mvp.md`、`docs/architecture.md`、`docs/api.md` 里哪条成立、哪条过期、哪条没做。
- 分三个检查点交付：① 分级差异清单加建议修订，等你逐条裁决；② `npm run check:docs` 接入 `tests.yml`；③ `docs/evidence/INDEX.md` 的 21 条索引与三态报告。
- 「错误」与「做不成」同样举证：说某条坏了或做不到，要给出可复现的产物，不写一句结论了事。

## Context

- 前端是 mock 层：`src/app/api/**` 27 个 route handler 全读 `data/mock/state.json`，`src/server/**` 零实现；`docs/api.md` 是前后端唯一实际契约，`architecture.md` 第 6 节指过去。
- 13 条里目前只有 1、2、4、5、6、13 有部分实现，其余属 M2–M7 未开始；未开始的条目不算「不一致」。
- 已知漂移：`mvp.md:19` 写「建 Draft 并跑首轮」，`docs/briefs/v0-interaction-alignment.md:3` 记录已改为「先建 Draft，点创建项目转正，不自动部署」；`architecture.md` 第 5 节的 7 张表没有 draft，而 `/api/drafts` 存在（草稿 = 还没有项目的 chat）。
- `docs/evidence/` 有 5 个目录，README 只写分支名，没有 commit sha，也没有机器可读索引。
- CI 现有 `.github/workflows/tests.yml`，跑 lint、format:check、type-check、test、build 与两次 migrate；`scripts/` 目前只有 `db/migrate.ts`。

## Materials

- 一手（可作证据）：`docs/evidence/<slug>/` 的录屏、`steps/*.png`、README 里的 cURL 输出；`src/**` 的实现；`git log` 与 `git show`。
- 契约层：`src/shared/api/schemas.ts`、`src/app/api/**/route.ts`、`docs/api.md`。
- 二手（只作线索，不作证据）：`docs/briefs/**`、`docs/reqs/**`、任何「我实现过」的陈述。
- 缺证据就写「未检」，不补写，也不推断为完成。

## Boundaries

- 不改前端代码（`src/features/**`、`src/app/**`、`src/shared/api/**`）；发现前端错了单独立条，不夹进文档修订。
- 文档改动逐条等批准，不批量改：`mvp.md`、`architecture.md`、`api.md`、`AGENTS.md`。
- 不自行增删 13 条与 2.1 的范围结论；要改范围只提建议。
- `docs/adr/` 已接受的结论不改写，被推翻时新增一条并标注 superseded。
- 不为通过而造证据：不写没跑过的 cURL、不截没发生的状态、不放宽「未检」的定义。

## Done

- ① 一份 `docs/` 下的差异清单，每条标滞后、未交付或真冲突，加影响文件与建议修订；你逐条裁决后才动文档。
- ② `npm run check:docs` 退出码可读，接入 `tests.yml`：过期红、真冲突红、「未检」不红。
- ③ `docs/evidence/INDEX.md` 覆盖 13 条与 2.1 的 8 条，每条一行：承诺、证据路径、覆盖路径 glob、sha、三态。
- 三个检查点各自等确认后再进下一个。

## Assumptions

- 过期判定用路径 glob：契约条目映到 `schemas.ts` 与对应 `route.ts`，UI 条目映到 `src/features/<域>/`；不做 import 依赖闭包。
- `AGENTS.md` 增加一行 `check:docs` 入口，作为 ① 的文档修订之一。

## Open questions

- CI 接入没落地：推送被 GitHub 拒绝（OAuth App 缺 `workflow` scope）。`.github/workflows/tests.yml` 要补两行：`npm run check:docs`，以及 checkout 的 `fetch-depth: 0`（浅克隆算不了证据新鲜度）。
- `docs/evidence/frontend-from-prototype/` 已过期：录于 `0eb6a93`，`a7a9702` 重做了侧栏、对话面板、项目区与 mock 场景。重录还是退役，等你定；它现在记在 `docs/evidence/INDEX.md` 的「过期与退役」里。
