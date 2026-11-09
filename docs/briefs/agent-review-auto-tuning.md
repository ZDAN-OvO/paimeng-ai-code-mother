# Brief: 把开发反馈循环与离线自动调优写成可直接实现的设计文档

- Stage: execute
- Source: `docs/reqs/agent-review-auto-tuning.md`；用户复述「plan 和 todo 是工具，交给主 agent 决定是否调用，不做成强制工作流；code/completion review 做成 subagent，review 前需要有 CI；系统提示词离线自动调优，夜间自动拿数据集跑测试，对比结果，提 PR，测试集合需要持续维护」；补充「现在是写 brief 去更新文档，不是编码实现」

## Goal

- 让写 M2 及之后代码的人（下一次会话的 agent 或用户本人）只读 `docs/` 就能实现开发反馈循环、验收用例、评测与夜间调优，不必回头重新讨论方向。
- 覆盖整条阶梯（Q1=a）：rung 1 循环契约，rung 2–4 验收用例与评测方法，rung 5 离线夜间调优与测试集维护。
- 需求文件里保留的 S1–S14（含 S3a、S3b）在文档里都有落点，没有一条只留在 `docs/reqs/`。

## Context

- 现行 `architecture.md` §6.1 写的是「不另设 Planner Agent 或检查 Agent」「两个问题是结果分支，不是额外 Agent」，`verify_project` 与 `complete_task` 是工具；§6.3 写 Todo 与 Plan。新方向推翻其中的检查 Agent 结论。
- 新方向：Plan、Todo 是主 agent 自行决定调用的工具，不做强制工作流；code review、completion review 是 subagent，包成工具由主 agent 判断何时调用，二者不是一对一；小改动只跑确定性检查（CI），大改动在 CI 之后加 code review，交付前才 completion review；宿主底线是 CI 每轮必跑、没有通过记录的修订不能标成功。
- 只有 CI 没有 CD，发布仍由用户触发；不做上线后自动调优（与 ADR 0007 冲突）。模型是 deepseek-v4.1-flash 与 glm-5.3-flash，主 agent 与 review agent 用不同家族。
- 工作区里有按旧理解写的未提交改动：ADR 0010（写了「不引入验证 Agent」）、0011（写了「外层不引入第二个 Agent」）、0012、`GLOSSARY.md` 新增的「业务编排循环」词条；`docs/planning/` 的三份 `.md` 与 `prototype-gap-analysis.html` 已暂存删除，`agent-loop.html`、`agent-tools-and-skills.html` 还在。
- 仓库还没有 agent 运行时：未装 `ai`／`@ai-sdk/*`，`src/server/` 只有 `db/` 与 `id.ts`；文档写的是待实现的设计，不能写成已实现。

## Materials

- 主源：`docs/reqs/agent-review-auto-tuning.md`（Ladder、Deeper 的 Kept／Dropped）与本次会话里用户的逐条裁决。
- 现行文档：`docs/architecture.md` §6、§11、§12，`docs/mvp.md` §2.1、§4、§6、§9，`docs/adr/0002`、`0004`、`0006`、`0007`，`GLOSSARY.md`，`docs/api.md` 的 SSE 事件与 status 枚举。
- AI SDK subagent 事实只引官方文档 https://ai-sdk.dev/docs/agents/subagents （工具内调用子 `ToolLoopAgent`、上下文隔离、子 agent 工具不能走审批）；文档没写的能力标「待核实」，不推断。
- `archive/paimeng-ai-code-agent/evals/` 只作覆盖面参考，不照搬用例、判分提示词或 rubric。
- 已删的 `docs/planning/*` 不作为来源；方法名（McNemar、pass^k、Cohen's κ、GEPA／DSPy）只写用途与适用条件，不编造效果数据。

## Boundaries

- 只改文档：`docs/architecture.md`、`docs/mvp.md`、`docs/adr/`、`GLOSSARY.md`，必要时 `docs/api.md`；不改 `src/**`、`scripts/**`、`package.json`、`.github/**`。
- 不改 13 条与 §2.1 的范围结论；新增的评测与调优里程碑写进 `mvp.md` 前先给出拟改文本，等用户批准。
- 已接受（已提交）的 ADR 不改写，被推翻时新增一条并在旧条目顶部标 superseded；未提交的 0010–0012 可以直接重写或丢弃。
- 不把设计写成已实现，不写阈值以外的虚构数字；拦截率 ≥ 90%、误打回率 ≤ 5%、k = 3、保留集每份 20 条、抽检 10 条是用户已定的值，其余数值留给用户或标「待定」。
- 不新建 `docs/evals.md` 或其他平行文档（Q2=a）；架构只在 `architecture.md`，范围与时间只在 `mvp.md`。

## Done

- 检查点 ①：一份大纲，列出每个文件要加或改的节、每条 ADR 的标题与结论一句话、S1–S14 各自落在哪一节，以及冲突项（0010–0012、GLOSSARY 词条、`docs/planning/` 残留）的处置；用户批准后才写正文。
- 检查点 ②：按批准的大纲写完正文，`architecture.md` 有循环契约与「评测与调优」两部分，`mvp.md` 有里程碑与 4.x 决策记录及 §9 变更，ADR 每条一个决策，`GLOSSARY.md` 补齐新术语并删掉错误词条。
- 验证：`npm run check:docs` 输出 `docs check ok`，`npx prettier --check "docs/**/*.md" "*.md"` 通过，`grep -rn "planning/"` 在 `archive/` 之外只剩变更记录。
- 交付时附一张对照表：S1–S14 → 文件与节号；不提交，等用户说再提交。

## Assumptions

- 冲突项处置：0010、0011 按新方向重写（完成判定仍由宿主按证据裁定，但 review 是 subagent 工具）；0012（文件操作走专用工具）与新方向不冲突，保留；「业务编排循环」词条删除，改为 code review agent、completion review agent、漏审率、保留集等术语。
- `docs/planning/` 剩下的两个 `.html` 一并删除，内容已由本次文档承接。
- 拟写的 ADR 至少四条：review 做成 subagent 并由主 agent 决定调用；宿主底线（CI 必跑、无通过记录不能标成功）；判定基准靠预埋缺陷、不靠 LLM 判分；只做离线调优、不做线上调优。最终条数以检查点 ① 的大纲为准。
- 夜间调优的运行位置写成本机定时任务、密钥留本机、PR 开到新分支，与 ADR 0007 一致；开 PR 的身份与每晚 token 上限写成待定配置项。

## Open questions

- 夜间任务开 PR 用哪个 GitHub 身份、每晚 token 上限多少，文档里先写成待定配置项，等实现前定。
