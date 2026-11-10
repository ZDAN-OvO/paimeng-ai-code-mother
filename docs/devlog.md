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
- 真实拒绝路径（不只看单测）：不传任何报告运行 `npm run pr:gate -- --remote origin --remote-ref refs/heads/main` 得到 `pr-gate: 拒绝开 PR`，逐条列出缺少 CI 与两份报告。

### 第一轮代码审查打回（2026-11-10）

候选提交 `c99984c` 的 CI 与本地检查都过了，但 code review 判 `changes_requested`，两条都会让门禁误放行：

| 问题               | 复现                                                                                                       | 期望                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 两份审查不校验角色 | 同一份 `reviewer=code` 的报告同时传给 `--code-review` 和 `--completion-review`，输出 `pr-gate: ok`、exit 0 | 位置与角色必须匹配，角色缺失或不符即拒绝 |
| 远端读的是本地缓存 | 审查克隆不 fetch、远端已推进到 B：`@{upstream}` 停在 A，`ls-remote` 是 B，门禁仍放行 A                     | 远端头必须向远端查询；查不到即拒绝       |

复现原始输出在运行产物 `repro-role-confusion.log`、`repro-stale-upstream.log`（私有，不入库）。

**修复**：`gate.ts` 的 `checkReview` 增加角色参数，`code`/`completion` 位置各自校验 `reviewer`；`pr-gate.ts` 用 `git ls-remote --heads <remote> <branch>` 解析上游实际头，无 upstream 时用 `origin/<当前分支>`，仍无则要求 `--remote`，且显式值与远端实际头不一致时拒绝。

**先红后绿（本轮）**：

- 红：新增角色与远端用例后 `vitest run scripts/pr-gate` → `Tests 6 failed | 11 passed`；失败项为角色互换两次、缺 reviewer 字段、远端已推进、同一份报告填两个位置、显式 `--remote` 不一致。
- 绿：修复后 `Test Files 2 passed`、`Tests 17 passed (17)`。
- 用 review 原来的两个场景复验：同一份 code 报告填两个位置 → `completion review 的 reviewer 是 code，应为 completion`、exit 1；远端已推进未 fetch → `远端分支是 d2f7b86…，不是候选提交 c28f612…`、exit 1。

### 第二轮代码审查打回（2026-11-10）

候选 `f6b0dfb` 上，第二轮 code review 又找出三条与远端解析相关的问题，都是我第一版修复引入或没覆盖的：

| 问题               | 复现                                                                                                                                                                     | 期望                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 分支名可伪装成后缀 | 远端有分支 `a/refs/heads/main`：`endsWith('refs/heads/main')` 对它也为真，且字母序在 main 前，`find` 取到它，门禁把候选判成与远端一致                                    | 按 ref 字段完全相等匹配                        |
| 远端名含斜杠解析错 | remote 名为 `team/origin` 时按第一个 `/` 拆成 remote=`team`，`ls-remote` 报仓库不存在，正常分支被误拒                                                                    | 从 `branch.<名字>.remote/merge` 取，不拆显示串 |
| 解析失败当未配置   | 配了 `branch.main.remote=publish`、`merge=refs/heads/release`，但本地删掉 `refs/remotes/publish/release`：`@{upstream}` 报错被吞成空，回退查 `origin/main`，放行了旧提交 | 仅有配置缺失时才回退；已配置但查不到一律拒绝   |

复现日志：`repro-branch-suffix-trap.log`、`repro-remote-name-with-slash.log`、`repro-upstream-fallback.log`（私有运行产物）。在被审候选 `f6b0dfb` 上，前两条分别是误放行与误拒，第三条是 `pr-gate: ok` 误放行。

**修复**：`resolveRemote` 改为读 `git config branch.<当前分支>.remote` 与 `branch.<当前分支>.merge`，不解析 `@{upstream}` 的显示串；`remoteHead` 用 `git ls-remote <remote> <ref>` 后按 ref 字段完全相等匹配；只有配置缺失时才回退 `origin/<当前分支>`。

**先红后绿（第二轮修复）**：新增三个用例后先红（`Tests 2 failed | 7 passed`，trap 分支与斜杠远端），实现后 **20 项全部通过**；第三条用例在旧实现上单独跑确认红（`expected +0 to be 1`），再在新实现上绿。三个场景也在临时仓库复验：trap 分支与配置缺失均拒绝、斜杠远端正常放行。

### 第二轮附带的文案与回退问题（2026-11-10）

审查还指出：没有上游配置时提示“可用 `--remote` 指定”，但实现无条件拒绝，等于该回退永远不生效。该轮改为只有拿不到 `branch.<名字>.remote/merge` 时才接受 `--remote`，已配置但查不到时即使给了也拒绝；另把“缺 reviewer 字段”拆成空字符串与真正缺键两个用例。

### 第三轮代码审查打回（2026-11-10，用户授权第三次修复）

第三轮判 `changes_requested`，两条 major 都属于“把远端核验交给调用者或本地引用”：

| 问题                                                    | 后果                        | 修复                                                                                  |
| ------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| 游离 HEAD 时 `--remote <SHA>` 的裸 SHA 不经查询即被接受 | 远端已推进仍可放行旧提交    | `--remote` 改为远端名，另加 `--remote-ref refs/heads/*`，仍然实际查询；只给一个即拒绝 |
| 上游可指向 `remote="."` 或 `merge=refs/tags/*`          | 本地 ref/tag 冒充远端分支头 | 拒绝本地上游与非 `refs/heads/*` 的 ref                                                |

复验日志：`repro-round3-findings-after-fix.log`（裸 SHA、远端已推进的游离 HEAD、`remote=.`、tag ref 全部拒绝）与 `repro-round3-control-pass.log`（正常配置、以及游离 HEAD 给出可查询远端分支时放行）。

**先红后绿**：新增四条用例后 `Tests 4 failed | 11 passed`；实现后 `Tests 26 passed`。

同时纠正上一节的表述：名为“已配置但查不到”的用例当时只删了本地 tracking ref，远端分支仍然存在、查询会成功，实际证明的是“SHA 不一致时拒绝”，不是“查询失败时拒绝”。现在换成远端分支确实不存在（配 `publish` 上未创建的 `release`），断言落在“已配置的上游不因查询失败回退”。

计划措辞同步：`--remote <sha>` 的写法作废，改为 `--remote` 加 `--remote-ref`，本机私有总纲已更新。

### 第四轮打回后改换信任来源（2026-11-10，用户选 A）

第四轮判 `changes_requested`，两条仍是同一类：显式参数会被 `origin/<分支>` 提前返回跳过；只拦字面量 `.`，`./`、绝对路径、`file://`、别名仍指向当前仓库。四轮下来每轮都修掉被点名的写法、下一轮又找到新写法，根因是**门禁在用本地 git 配置推断“哪个才是真远端”**，而本地配置可任意改写。

改为信任 GitHub：远端头用 `gh api repos/<owner>/<name>/git/ref/heads/<branch> --jq .object.sha` 查询，与 PR 看到的是同一来源。本地 remote、路径、tag、别名不再参与判断。仓库从 `origin` 的 github.com URL 解析，解析不到要求 `--repo owner/name`；分支取当前分支，游离 HEAD 要求 `--branch`；查询失败（无登录态、分支不存在、网络不可达）一律拒绝，不回退。

参数变化：`--remote` / `--remote-ref` 作废。

**先红后绿**：按新接口重写入口测试后 `Tests 7 failed`（放行、远端推进、无 origin、坏 `--repo`、游离 HEAD 两例、查询目标）；实现后 `Tests 23 passed`。真实环境核对：`gh api` 返回的远端头与本地 HEAD 相同，CLI 只报缺少三份报告，没有再报远端查询问题。

### 门禁、审查与 PR

（本节在下一轮审查与开 PR 后补：候选提交 SHA、CI 运行链接、两份报告结论、实际耗时。）

### 偏离计划的地方

- 计划写 `scripts/pr-gate.mjs`，实际为 `scripts/pr-gate/gate.ts`（判定逻辑，可单测）加 `scripts/pr-gate.ts`（CLI，`npm run pr:gate`，用已装的 `tsx` 执行）。拆两个文件是为了 CLI 被 import 时不执行；`vitest.config.mts` 的 include 相应加入 `scripts/**/*.test.ts`。
- 本轮没有产品页面变化，按计划不为展示生成 GIF。
