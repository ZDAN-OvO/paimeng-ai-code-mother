# 用 Vercel AI SDK 替换 pi-durable 的重构计划

把生成执行从 `@earendil-works/pi-durable` 1.4.0 换到 AI SDK 7 加 Workflow DevKit。产品控制面保持不变，包括 authority、输入水位、预算、写门禁、构建、发布和计费。
范围覆盖新执行引擎、工具迁移、上下文压缩、流式与历史、崩溃恢复、人机追问和旧依赖删除。
不加入多机调度、跨区域队列、模型管理改造，也不恢复已搁置的沙箱计划。
整体通过条件。真实浏览器完成创建、生成、断连后继续、`kill -9` 后续跑、追问、取消和发布；旧会话切换后显示空历史且页面不报错；产品代码不再 import `@earendil-works`。
顺序为 PR-00 spike，然后 PR-01 到 PR-07 串行。PR-00 已完成，不合并；其余每条在前一条合入后开工。

## How to read this

Status. PR-01 已在分支 `agent/vercel-ai-sdk-p01` 实现并推送（PR #172），等待独立核验。PR-00 有条件通过，它提出的设计缺口已在本文件逐条关闭。2026-11-05 operator 决定采用 `WorkflowAgent`，模型以可序列化的槽位引用跨 step 边界，见 D2。operator 同时确认 pi-durable 的历史对话可以丢弃，PR-06 因此从「导出加双读」简化为「备份后切换」，见 PR-06。

Blockers. None。PR-00 已回答 Next 版本、自托管 Postgres、崩溃恢复和流式重连。默认 job 锁不满足恢复需求，已定为部署必配项。

Execution. 本文是实现顺序的权威来源。每条 PR 只交付到 merge-ready。推送、创建 PR 和合并分别另获授权。前一条独立核验通过并合入后，下一条才开工。

Roles. 实施者负责产品代码、检查代码与原始证据。独立核验者由未参与该 PR 修改的人担任，按项目现有的独立核验做法跑真实路径并核对原始产物：另起一个没参与该 PR 的核验者，不用作者的自测脚本。operator 决定产品体验与是否合并。

Permissions. 本轮只允许编辑本计划。改产品代码、装依赖、推送、合并和删除数据分别另获授权。例外：为让本地未跟踪的 `spike/` 目录不进入检查，`eslint.config.mjs` 与 `tsconfig.json` 各有一处 ignore，随本 PR 提交，不涉及产品代码。

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the `autopilot-stack` playbook from the local pstack plugin, which is not in this repository; see "Arm the program" below. Each PR is built and verified to merge-ready, and the operator lands it. PR-00 is a spike and never lands.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Live evidence uses a real browser and real services. Thresholds move only with the operator's written approval, never to make a PR pass.

Lanes. 每条 PR 指定 3 到 5 条 live lane，按该 PR 的真实用户路径覆盖。不套用十条通用 lane，因为生成引擎的大部分改动只落在少数承重场景上。

## Decision

| 方案 | 内容 | 代价 | 结论 |
| --- | --- | --- | --- |
| A | 保留 pi-durable | 固定版本、schema 单向门、协议锁步、单写者与单人维护 | 不采纳，由 operator 决定 |
| B | AI SDK `ToolLoopAgent` 加自建持久层 | 重建存储、检查点、工具重放、排队和恢复 | 不采纳，工作量接近现状 |
| C | AI SDK 加 Workflow DevKit，自托管 Postgres world | 依赖 Workflow DevKit 的成熟度与自托管运维 | 采纳 |
| D | AI SDK 加 Temporal、Restate 或 Trigger.dev | 引入第二套调度基础设施与部署模型 | 不采纳，运维面过大 |

选择 C 的理由。仓库已经有 `ai@7.0.130` 与模型适配。Workflow DevKit 提供事件溯源、step 重试、跨重启恢复、可暂停运行和持久流。PR-00 验证了事件溯源与持久流、step 重试、跨重启恢复三项，以及 AI SDK 工具循环；可暂停运行没有验证。

事实与推断需要分开。仓库里没有记录证明 pi-durable 的运行时故障率。operator 的「不够稳定」是使用体验判断，不是本文测得的结论。可核实的迁移理由是维护成本与单点知识。当前生成执行由 6,719 行产品代码包住一个固定版本 SDK（`src/server/generation/durable/**` 加 `durable-engine.ts`），执行语义只有一个人熟悉。改用 AI SDK 是 operator 明确的学习目标，本文把它当约束记录，不用它降低行为验收。

## PR-00 findings

完整记录在 `runtime/evidence/ai-sdk-migration/PR-00/handoff.md`，证据索引在同目录 `index.md`。

1. Workflow 5.4.0 在 Next 16.4.2 与自托管 Postgres 16 上运行，`withWorkflow` 与 `world.start()` 可用。Next 16 的 `allowedDevOrigins` 必须包含本机来源，否则浏览器端 HMR 失败。
2. AI SDK 7 的模型调用与工具执行可以拆成独立 workflow step。一次运行产生 16 个 step，已完成 step 在重启后不重放，只有被中断的 step attempt 从 1 变 2。
3. 默认 job 锁配置下，`kill -9` 后运行在 90 秒观察期内一直 `running`，job 锁在已死 worker 上。设置 `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30` 后，重启后 28 秒恢复并完成（`recoveredAfterSeconds`）；整次运行含崩溃前的部分，总时长 206.9 秒。
4. 持久流可在运行结束后用同一 runId 重连读回。
5. `run.cancel()` 只改运行状态，不中断在执行的 step。取消后 20 秒，慢工具仍完成并写副作用。
6. `@workflow/ai@5.0.3` 的根导出不含 agent，`DurableAgent` 已废弃且要求 `ai ^6`。Workflow 5 的对应包是 `@ai-sdk/workflow@2.0.95`，根导出 `WorkflowAgent`，依赖 `ai@7.0.163`。
7. 资源量。开发模式下 5 次运行后，`next-server` 常驻 RSS 约 805 MB，事件表 208 行，step 表 64 行，数据库 8.9 MB。行数与数据库大小见 `perf.json`；RSS 来自进程采样，没有单独存档。

## Design decisions

以下十二条把计划补到可实施状态。每条同时给出落点 PR。

### D1. 执行栈

采用 AI SDK 7 加 Workflow 5 加 `@workflow/world-postgres`。`workflow@5.4.0`，`@workflow/world-postgres@5.1.1`，`ai@7.0.163`。`@ai-sdk/workflow@2.0.95` 是默认执行层：agent 循环、模型调用 step 与工具 step 都由它组织。落点 PR-01。

### D2. Agent 循环

使用 `WorkflowAgent`，在 workflow 函数体内创建。工具 `execute` 声明为 `'use step'`。模型通过 `AgentModelRef` 跨 step 边界，只携带槽位字符串，在 step 进程内重建。

形状。

```text
agentWorkflow(input)
  openRun()                  step
  prepareTurn()              step   投递输入、读历史、定模型槽位
  WorkflowAgent.stream
    doStreamStep             step   每次模型调用
    <toolStep>               step   每个工具调用
  persistTurn()              step
  finishRun()                step
```

模型实例不能直接作为 step 参数。Workflow 序列化只保留字符串、数字、布尔，`config.url`、`fetch`、`headers` 这些函数会被过滤掉（AI SDK custom providers 文档），实测的表现是实例能跨过边界，模型调用再报 `this.config.url is not a function`。官方给自定义 provider 的解法是实现 `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE`。`AgentModelRef` 按这个协议只序列化槽位，反向解析发生在 step 进程里，配置和密钥都还在。`model-ref.ts` 不 import `infra/` 与 `models/`，否则 pg 会被编进 workflow VM，构建直接报 `node-js-module-in-workflow`。

2026-11-05 一次回显运行的 12 个 step：`openRunStep` → `prepareTurnStep` → `prepareWorkflowAgentTelemetry` → `doStreamStep` → `writeDeferredToolCalls` → `echoToolStep` → `writeToolResults` → `doStreamStep` → `writeDeferredToolCalls` → `closeStream` → `persistTurnStep` → `finishRunStep`。产品自己的是 openRun、prepareTurn、echoTool、persistTurn、finishRun；其余由 `@ai-sdk/workflow` 生成。持久化粒度仍是每次模型调用、每个工具调用各一个 step。证据 `runtime/evidence/ai-sdk-migration/PR-01/workflow-agent-db.json` 与 `workflow-agent-run.log`。

输入注入与压缩仍未实现：`prepareStep` 与 `activeTools` 接口存在。输入投递的落点按 D6 是 PR-05，压缩的落点按 D12 是 PR-03；PR-02 只做工具与守卫，不含这两项。

### D3. 工具形状

每个工具声明一份 `ToolSpec`，字段为 `name`、`description`、`inputSchema`、`replay`、`run`。`replay` 取 `safe` 或 `unsafe`。`agentTool(spec)` 把它转成 AI SDK `tool`，`execute` 是 `'use step'` 函数，在函数内调用 `withToolGuards`。

`withToolGuards` 在一次调用内依次检查 authority、执行绑定、写门禁、工作区相对路径、工具预算，再执行 `spec.run`。守卫与工具主体在同一个 step 内，不能拆开，否则崩溃后守卫和副作用会分叉。落点 PR-02。

### D4. 在执行的 step 与幂等

Workflow 对崩溃时正在执行的 step 是至少一次语义。`maxRetries` 只约束抛错后的重试，拦不住崩溃重放。产品用一张 `agent_effect` 表兜底。

表的主键是 `(run_id, tool_call_id)`，字段包含 `tool_name`、`replay`、`status`、`result_json`、`create_time`、`update_time`。`status` 取 `started`、`completed`、`failed`、`cancelled`。

执行顺序。

1. 查到 `completed` 时直接返回 `result_json`，不重跑。
2. 查到 `started` 且工具是 `unsafe` 时，不重跑，向模型返回 `interrupted` 结果。
3. 查到 `started` 且工具是 `safe` 时，重新执行并更新结果。
4. 没有记录时，先插入 `started`，执行，再写 `completed`。

工具面共 11 个：`read`、`write`、`edit`、`listFiles`、`buildPreview`、`git`、`ask`、`webSearch`、`readWebPage`、`searchImages`、`importImage`。`m1_wait` 只在夹具模式注册，不参与迁移。`edit`、`ask`、`importImage` 是 `unsafe`；`importImage` 会把图片写进工作区，重放会重复写入。`read`、`write`、`listFiles`、`buildPreview`、`webSearch`、`readWebPage`、`searchImages` 是 `safe`。`git` 目前在 `git-tool.ts` 里没有声明 `replay`，pi-durable 对未声明的按 `unsafe` 处理，PR-02 要显式标成 `safe`，它只允许只读子命令。`buildPreview` 重跑前要清掉上一次的临时产物，保持构建幂等。

模型调用的计费也要幂等。`generation_step` 增加引擎步标识；它现在没有 `run_id` 列，PR-03 先补列，再对 `(generation_id, run_id, engine_step_id)` 建唯一约束，写入用 `ON CONFLICT DO NOTHING`。预算预留同样以引擎步标识为键，step 重放时复用已预留的额度，不重复计数。落点 PR-02、PR-03。

### D5. 转录

新增两张表。`agent_conversation` 保存 app 到 conversation 的映射和最后序号。`agent_message` 保存消息，字段为 `id`、`conversation_id`、`run_id`、`seq`、`role`、`parts`、`input_id`、`create_time`、`update_time`。`parts` 直接存 AI SDK `UIMessage` 的 parts，不另造一套中间格式。

消息 id 在写入时生成，稳定持久。`loadMessages` 按 `seq` 升序投影为 `UIMessage[]`。工具调用、工具结果和附件都放在 parts 里。旧转录不迁移：operator 在 2026-11-05 确认历史对话可以丢弃。落点 PR-01、PR-04、PR-06。

### D6. 输入水位

`generation_input` 保留 `requestId` 幂等和单调 `seq`。现在的状态有五个：`accepted`、`placed`、`resolved`、`withdrawn`、`unanswered`（`src/server/infra/schema.ts:230`）。新模型收窄到两个写入态：`queued` 对应 `accepted` 与 `placed`，`resolved` 表示对应消息已写入 `agent_message` 并提交。`withdrawn` 保留，表示用户撤回，不再产生消息，也不计入水位。`unanswered` 保留，表示本轮结束时仍未结算，它和 `queued` 一样挡住发布门禁，直到下一轮结算或撤回。完成水位只认连续前缀，发布要求没有未结算输入。

投递路径。接口先写 `queued`。循环在每次模型调用前执行 `loadInputs()` step，按 `seq` 读取本 conversation 的 `queued` 行，按顺序追加用户消息，并在同一事务里把行改为 `resolved`，写 `run_id` 与 `message_id`；`agent_message.input_id` 反向指向输入行。`ask` 的回答是新一轮输入，走同一条路径。这样水位信号只依赖产品表，不再依赖 SDK 的提交回执或转录条目。这是有意的语义简化，PR-05 必须用旧的发布门禁场景对照验证，确认「未结算输入不能发布」仍然成立。落点 PR-01、PR-05。

### D7. 存储位置

Workflow 的 `workflow` 与 `workflow_drizzle` schema 放在 `paimeng_agent`。它是现有的执行库，备份已经覆盖。job prefix 固定为 `paimeng_agent_`，避免与同库其他应用冲突。

PR-07 的删表清单是 `durable_schema` 等 9 张表（`durable/storage-pg.ts:186-253` 建 8 张业务表，`1202` 建 `durable_schema` 本身，`1247` 的 reset 列表正好是这 9 张），明确排除 `workflow` 与 `workflow_drizzle`。删表前必须有 `pg_dump` 备份和 operator 授权。落点 PR-01、PR-07。

### D8. 取消

取消使用 Workflow 的持久 `AbortController`，不用产品轮询标志。

workflow 函数创建 `new AbortController()`，并把 `signal` 传给模型调用和每个工具。工具在写副作用前调用 `signal.throwIfAborted()`。构建工具把 signal 传给 Docker 子进程，abort 时杀掉子进程。

取消入口先用产品鉴权确认调用者。运行创建时把取消 hook 的 token 写入 `agent_run`。运行已注册取消 hook 时调用 `resumeHook('agent-cancel:<runId>')`。workflow 用 `Promise.race` 等待模型循环与取消 hook，hook 先到时调用 `controller.abort()`，等待当前 step 收束，写 `cancelled` 终态并结算已发生步骤。运行还没注册 hook 时，写 `agent_run.cancel_requested`，workflow 启动时先检查该列。

验收标准是取消后 1 秒内不再产生新副作用，正在执行的构建被终止，计费只覆盖已完成的 step。落点 PR-05。

### D9. 版本

`ai` 从 `7.0.130` 升到 `7.0.163`。`@ai-sdk/provider` 与 `@ai-sdk/provider-utils` 跟随 `ai` 的依赖版本。`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/openai-compatible` 升到与 provider 4 兼容的最新版，并用现有模型适配测试验证。`npm ls ai` 必须只有一个版本。落点 PR-01。

### D10. Worker 拓扑

默认让 Next 只负责入队、读状态和流式读取，队列由单独的 `agent-worker` 进程消费。PR-01 的结论与预期不同：worker 不能在自己的进程里执行 workflow 与 step，队列消息以 HTTP 投递到 Next 的 `/.well-known/workflow/v1/flow`。worker 因此只是调度器，workflow 与 step 跑在 Web 进程里。`instrumentation.ts` 进程内模式也被否掉，理由见下一条。PR-01 只观察了单 worker，双 worker 的队列竞争留到 PR-05。落点 PR-01。

PR-01 复核结论。独立 worker 保留，但它只是调度器。队列消息以 HTTP 投递到 Next 的 flow 路由，workflow 与 step 仍在 Web 进程执行。三个约束必须写进部署：

- worker 必须设置 `WORKFLOW_LOCAL_BASE_URL` 为 `APP_ORIGIN`。不设置时投递报 `Unable to resolve base URL for workflow queue`；指向 `127.0.0.1` 会吃到产品的主机名重定向（307）。
- `@workflow/world-postgres` 不能被 Next 的任何 layer 静态导入。放进 `instrumentation.ts` 会让 Next 的 edge 编译解析 `graphile-worker` 与 `graceful-fs` 的 Node 内建依赖失败，整个 `/api` 起不来。world 由 `WORKFLOW_TARGET_WORLD` 在运行时动态加载，`world.start()` 只在 worker 里调用。
- Web 进程承载长 step，按单实例部署。多实例不在本期范围。

### D11. 流式

模型调用使用 `WorkflowAgent.stream`（底层是 `streamText`），产出 AI SDK 原生 `UIMessageChunk`。workflow 通过 `getWritable()` 把分片写入持久流，Next 的流式路由用 `run.getReadable()` 读出。客户端断开只结束读取，不结束运行。刷新或重连时用同一 runId 重新读取，已写入的分片可以重放。落点 PR-04。

### D12. 压缩与预算

上下文压缩是产品代码。每次模型调用前估算消息 token，超过阈值时执行 `compact()` step，调用同一模型生成摘要，写入一条 summary 消息并替换窗口内的旧消息。摘要调用计入模型预算，摘要结果持久化，重启后不重算。

预算分为模型调用、工具调用、压缩、自检构建、平台构建和 repair 六类。模型与压缩在 step 开始前预留，工具在守卫内预留，构建在观察者内预留。所有预留以引擎步标识为键，重放时复用。落点 PR-03。

## Capability map

| 现有能力 | pi-durable 的承担者 | 新方案承担者 | 需要产品补的部分 |
| --- | --- | --- | --- |
| 模型与工具循环 | `GenerationTask` 与 `ToolTask` | `WorkflowAgent`，模型调用与工具调用各是一个 step | D2、D3 |
| 每步检查点与恢复 | `tasks` 表、checkpoint | Workflow 事件日志与 step | 无 |
| 工具安全重放 | `replay: safe` 与 `unsafe` | `agent_effect` 加 step 重放 | D4 |
| 跨重启等待 | `sleeping` 状态 | Workflow `sleep` | 无 |
| 任务停住诊断 | parked 与 `/inspection` | Workflow 运行状态与重试上限 | 诊断入口 |
| 上下文压缩 | 阻塞压缩 | `compact()` step | D12 |
| 转录存储 | 9 张 SDK 表 | `agent_conversation` 与 `agent_message` | D5、D6 |
| 流式事件 | AgentEvent 与适配器 | 原生 `UIMessageChunk` 与持久流 | D11 |
| 每轮模型描述 | `app.run-model` 文档 | `agent_run` 行 | PR-03 |
| 工具前写门禁与预算 | beforeTool 与 beforeRequest hook | `withToolGuards` | D3、D12 |
| 人机追问 | `ask` 与投稿队列 | 两段式输入与取消 hook | D6、D8 |
| 单写者 | advisory lock | Postgres world 队列 | D10 |
| 模型目录与凭据 | pi-ai 适配 | `src/server/models/registry.ts` 与 `adapters.ts` | 无 |

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start, and re-read them at every audit tick.
  - [ ] `git show origin/main:paimeng-ai-code-agent/docs/plans/vercel-ai-sdk-migration.md`
  - [ ] pstack 技能不在仓库里，只在本机插件目录：`~/.claude/plugins/cache/cursor-plugins/pstack/*/skills/poteto-mode/playbooks/autopilot-stack.md`、`.../skills/swarm/SKILL.md`、`.../skills/poteto-mode/playbooks/opening-a-pr.md`。代码托管里没有这些路径。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. If the session has no `/loop`, run the same tick manually at each PR boundary.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle this plan names. PR-00 is complete and does not run again.
- [ ] Follow the dependency graph. PR-01 to PR-07 run in order, and each starts only after the previous one merges.
- [ ] Hold the file boundaries each PR declares. `src/server/generation/agent/**` is written only by PR-01 to PR-07.
- [ ] Hold the review gate. PR-02 to PR-06 wait for the operator's screenshots and video review before merge. PR-01 has no user-visible change. PR-07 changes no interaction, so it waits for approval of the backup and deletion instead.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; use the repository's existing flow. Record any fallback.
- [ ] Open the PR ready, never draft, per **Opening a PR**. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Rebase again only at merge prep, on a real conflict with trunk, or when a concurrent change touches the same files.

### Verdict and merge, for every PR

- [ ] A full swarm runs once at the code-ready head. It covers the PR's unit checks, its live lanes and its perf block, plus at least two audit lanes that read the diff and the receipts and distrust the PR body.
- [ ] Judge every finding by the blocking rule. The verdict is clean when none blocks. A trunk defect is recorded against trunk and does not block the PR. A new head gets a fresh verdict.
- [ ] PR-01 to PR-07 are squash-merged by their owner only after a clean independent verdict and the operator's review where required.

### Start and sequence

依赖为 `PR-00 → PR-01 → PR-02 → PR-03 → PR-04 → PR-05 → PR-06 → PR-07`。不并行。
分支命名为 `agent/vercel-ai-sdk-p01` 到 `agent/vercel-ai-sdk-p07`。首条基于最新 `origin/main`，其后基于前一条合入后的目标分支。
`package.json`、`next.config.ts`、`src/server/infra/config.ts`、`src/app/api/[...path]/route.ts` 与迁移序号由当期 PR 独占。下一条 PR 在前一条合入后接续。
新增必填参数、表、状态和唯一约束必须在同一 PR 迁移全部调用者，不能留到下一条。
迁移序号在开工时从当时 trunk 重新取，不在本计划写死。

### File ownership

`src/server/generation/agent/**` 由 PR-01 建骨架，PR-02 到 PR-07 只改自己声明的文件。 同名的 `src/server/generation/agent.ts` 已经存在，是生成请求的 zod 契约，与新建目录并存；PR-02 起把它并入目录，避免一个名字对应两个东西。
`src/server/generation/tools/**` 由 PR-02 整体接管。
`src/server/generation/durable/**` 在 PR-01 到 PR-06 保持只读兼容，PR-07 整体删除。
`tests/integration/harness/**` 由 PR-02 到 PR-05 逐组替换，PR-07 删除旧组。
`docs/adr/` 在 PR-07 新增一份 ADR，取代 ADR 0003。

### Evidence rules

Versions. 每次运行保存 base 与 head 完整 SHA、diff、Node 与 npm 版本、`ai` 与 `@workflow/*` 版本、Postgres 与 Redis 目标库、探针 hash 和 fixture 版本到当期 `runtime/evidence/ai-sdk-migration/PR-XX/versions.json`。
Invalidation. 改代码、依赖、基线、配置或探针后，重跑受影响的 unit、live 和 perf 检查。旧证据留在独立子目录，不覆盖后声称绑定旧 SHA。
Input boundary. 用户操作走真实浏览器。数据库重置只允许 `_test` 库。开发实例 live 路径不重置开发库，只使用本轮新建的账号和 App。
Binding. 每条结论绑定「结论、断言源码行、原始产物」三件事。截图至少覆盖操作前、关键中间态、结果和刷新。跨进程恢复场景必须留视频或 trace。

### Boot recipe, for every live lane

隔离路径使用 `paimeng_app_test`、`paimeng_agent_test` 和 Redis DB15。先跑 `npm run db:test:setup`，再按当期 PR 的 spec 运行。
开发实例 live 路径使用现有验证技能的 Launch、Doctor、Drive 和 Cleanup。模型只用 fixture。启动 `npm run dev` 后检查 Next、`agent-worker` 和 Postgres world 的健康状态。
worker 必须由 launcher 起停，并在退出时排空队列。不能遗留后台进程。
需要故障注入时，只杀本轮拥有的 Next 进程。workflow 与 step 跑在它里面，worker 只做调度，杀 worker 测不到在执行的 step。记录 PID 与信号，不用宽泛 `pkill`。
每期证据按 `runtime/evidence/ai-sdk-migration/PR-XX/` 归档，包括检查日志、原始样本、截图、trace 和 `handoff.md`。

### Verdict and handoff

每个 Behavior PR 由独立核验者跑真实用户路径，核对原始产物，给出绑定当前 base 与 head 的 PASS 或 PASS+NOTES。缺独立核验时保持 pending。
交互变化发生在 PR-02 之后的每一条，PR-07 除外：它只删旧引擎，operator 审的是备份与删除。
每条 PR 在 `handoff.md` 记录分支、SHA、未完成项、已知限制和授权记录。

### Cross-PR acceptance

| 场景 | 负责 PR | 观察面 | 失败条件 | 证据 |
| --- | --- | --- | --- | --- |
| 创建、生成、发布 | PR-02、PR-03、PR-04、PR-06 | Web、API、DB | 生成不落库、流式中断、发布失败 | 各 PR 的 journey 截图与日志 |
| 浏览器断开后继续 | PR-04、PR-05 | Web、DB | 断连取消运行，或重连丢消息 | 断连视频与消息计数 |
| Next 进程被 `kill -9` 后续跑 | PR-01、PR-05 | Web、worker、DB | 恢复超过 60 秒，或从头重跑 | 进程日志、恢复时间、trace |
| 在执行的 step 不写重复副作用 | PR-02、PR-05 | Web、DB、文件 | `edit` 执行两次，或构建产物重复 | `agent_effect` 行与文件 hash |
| `ask` 提问跨重启 | PR-05 | Web、DB | 回答丢失、写门禁未关闭、重启后无法继续 | 截图与 authority 行 |
| 输入水位与 `steer` 顺序 | PR-05 | Web、DB | 插队、乱序、未结算输入被发布 | `generation_input` 行与消息序列 |
| 取消与结算 | PR-05、PR-06 | Web、DB、文件 | 取消后 1 秒仍有新副作用、构建未停、计费步缺失 | 账目行、副作用时间戳、截图 |
| 历史消息完整 | PR-04、PR-06 | Web、DB | 工具调用或附件丢失、顺序错乱 | 同会话跨重启的计数对比 |
| 用量与计费一致 | PR-03、PR-06 | DB | 步骤数或 token 不一致且无解释 | 同一 fixture 的新旧对比 |
| 预算上限 | PR-02、PR-03 | Web、DB | 超过模型、工具、构建、压缩次数 | attempt 账本 |
| 模型身份与凭据重启不变 | PR-03、PR-05 | Web、DB | 重启后改投当前别名 | 请求日志与运行记录 |
| authority 与写门禁 | PR-02 | Web、DB | 无权限仍写入，或持权被误拒 | 拒绝日志与行锁记录 |
| 旧会话切空 | PR-06 | Web、DB | 旧会话打不开或页面报错 | 空历史截图 |

## 验证 AI SDK 与 Workflow 可行性 (PR-00)

**Depends on.** None.

**Result.** 有条件通过。记录、截图、视频与原始数据在 `runtime/evidence/ai-sdk-migration/PR-00/`。handoff 的八条发现都已写入本文的 PR-00 findings（F2 与 F4 合为第 2 条），设计决策已吸收 Job 锁与取消语义。

**Files.** 只写 `spike/ai-sdk-durable/**` 与 `runtime/evidence/ai-sdk-migration/PR-00/**`。不改产品源码。spike 不合并。

**Build.** 已完成。

- [x] 建独立 spike 包，安装 `ai@7.0.130`、`workflow@5.4.0`、`@workflow/world-postgres@5.1.1`。
- [x] 用 Next 16.4.2 接入 `withWorkflow` 与 `instrumentation.ts`，启动 Postgres world。
- [x] 用 `MockLanguageModelV4` 定义两个工具（`increment` 与 `slow`），模型调用与工具执行各是一个 step。
- [x] 在工具 step 中途 `kill -9` Next 进程（PR-00 的 spike 跑在 `next dev` 里），重启后确认从被中断的 step 继续。
- [x] 结束运行后用同一 runId 重连，读回完整流。
- [x] 验证 `run.cancel()` 不中断在执行的 step。

**You see.**

- [x] 页面正常发起运行并收到流式消息。
- [x] `kill -9` 后同一运行恢复，已完成 step 不重放。
- [x] 取消后运行状态变为 `cancelled`，但慢工具仍完成，说明取消需要协作。

**Verify, unit.** 无产品单测。spike 自带场景的退出码与日志已归档。

**Verify, live.** 测试本身不足以验证。三条 lane 已跑完。

- [x] Lane 1. 最小页面发起生成，收到流式消息。截图 `running.png`。
- [x] Lane 2. 工具 step 中途杀 Next 进程，重启后页面继续收到结果。证据 `default-lock-*`、`stale30-*`、`recovery.json`。
- [x] Lane 3. 运行结束后重连并读取完整流。截图 `completed.png`；取消场景截图 `cancelled.png` 与视频 `cancel-run.webm`。

**Verify, perf.** 已记录绝对值。

- [x] Metric. 恢复延迟、事件行数、step 行数、数据库大小、进程常驻内存。首 token 延迟留到 PR-04 测量。
- [x] Probe. 同一场景连续跑 5 次。
- [x] Baseline. 恢复延迟 28 秒（30 秒配置），事件 208 行，step 64 行，数据库 8.9 MB，开发模式 RSS 约 805 MB。
- [x] Rule. 恢复超过 60 秒、事件无上限增长或常驻内存超过 1 GiB 时阻塞。PR-00 没有触发阻塞。

**Review gate.** None。PR-00 不改产品交互。

**Merge.** 不合并。结论与证据保留在本轮工作树。

## 建立新引擎地基 (PR-01)

**Depends on.** PR-00。

**Result.** 本地完成，已推送为 PR #172，待核验。`WorkflowAgent` 跑通，模型以槽位引用跨 step 边界，独立 worker 只做调度。证据与未完成项在 `runtime/evidence/ai-sdk-migration/PR-01/handoff.md`。

**Files.** `src/server/generation/agent/world.ts`、`run-store.ts`、`transcript.ts`、`loop.ts`、`steps.ts`、`model.ts`、`model-ref.ts`、`run.ts`、`src/server/generation/agent/worker.ts`、`src/server/infra/config.ts`、`package.json`、`next.config.ts`、`scripts/dev/durable-dev.ts`、新增迁移、`tests/integration/agent/**`。

**Build.**

- [x] 把 `ai` 升到 `7.0.163`，同步 provider 包，跑现有模型适配测试，确认 `npm ls ai` 只有一个版本。
- [x] 建 `agent/world.ts`，初始化 Postgres world 与 worker。world schema 放 `paimeng_agent`，job prefix 用 `paimeng_agent_`，设置 `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30` 与 `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1`。
- [x] 建 `agent/worker.ts`，单独进程启动 `world.start()`，提供健康检查与排空。实测它不能在独立进程执行 workflow 与 step：队列消息以 HTTP 投递到 Next 的 flow 路由。worker 因此只做调度，风险记录见 D10。
- [x] 新增 `agent_run`、`agent_conversation`、`agent_message`、`agent_effect` 四张表，以及 `generation_input` 的 `run_id` 与 `message_id` 列。
- [x] 复用 `src/server/models/registry.ts` 与 `adapters.ts` 构造 AI SDK 模型，不保留 pi-ai 路径。
- [x] 加 `GENERATION_ENGINE` 开关，默认 `harness`，路由按开关选择引擎。
- [x] launcher 同时启动 Next 与 `agent-worker`，退出时排空。
- [x] `next.config.ts` 包 `withWorkflow`，并把本机来源加进 `allowedDevOrigins`。PR-00 第 1 条说这两项缺一不可。
- [x] 用 `WorkflowAgent` 跑通一次 echo 工具，验证输入写入、模型 step、工具 step、流写入。先试过手写循环，operator 在 2026-11-05 决定改用 `WorkflowAgent`，手写循环已删除。
- [x] 模型以 `AgentModelRef` 跨 step 边界，只序列化槽位，在 step 内重建。
- [ ] 输入注入、压缩、逐工具守卫和取消四项能力，PR-02 起逐项验收。

**You see.**

- [x] 开关为 `harness` 时旧路径行为完全不变。
- [x] 开关为 `agent` 时能创建会话、写入用户消息、跑一次 echo 工具并结束。
- [ ] 重启 Next 进程与 worker 后健康检查恢复，未完成运行继续。
- [x] `WorkflowAgent` 评估有书面结论与原始日志。结论：可用，见 D2。

**Verify, unit.** 四张表的 CRUD、开关路由、输入状态机。

**Verify, live.** 测试本身不足以验证。

- [x] Lane 1. 旧路径生成一次完整页面，确认无回归。保存截图。产物 `01-home-filled.png`、`02-chat-opened.png`、`03-generated.png`。
- [x] Lane 2. `agent` 开关下跑 echo 生成，刷新后消息仍在。保存截图。回显场景没有 UI 入口，证据是 `workflow-agent-run.log` 与 `workflow-agent-db.json`。
- [ ] Lane 3. 重启 Next 进程与 worker，未完成运行继续。workflow 与 step 跑在 Web 进程里，只重启调度器测不到在执行的 step。保存视频与日志。

**Verify, perf.** 空转 worker 内存与启动时间，记录绝对值。

**Review gate.** None。用户可见行为未变。

**Merge.** 独立核验通过后合并。

## 迁移工具与守卫 (PR-02)

**Depends on.** PR-01。

**Files.** `src/server/generation/tools/**`、`src/server/generation/agent/tool-spec.ts`、`guards.ts`、`effect-store.ts`、`src/server/generation/control-store.ts`、`tests/integration/agent/tools.test.ts`、`tests/unit/tools/**`。

**Build.**

- [ ] 把 11 个产品工具改为 `ToolSpec`，清单见 D4。`read`、`write`、`edit` 重新实现，保留工作区相对路径准入。
- [ ] 实现 `agentTool` 适配器，守卫只写一份 `withToolGuards`。
- [ ] 在守卫内检查 authority、执行绑定、写门禁、路径、工具预算，并写 `agent_effect`。
- [ ] 守卫给工具输出设上限，超过就截断并留痕，防止事件日志被长输出撑大。
- [ ] 按 D4 的分类写 `replay`：`edit`、`ask`、`importImage` 是 `unsafe`，其余是 `safe`。`git` 现在没有声明，按 `unsafe` 处理，本 PR 显式标成 `safe` 并保留只读子命令限制。`buildPreview` 重跑前清理临时产物。
- [ ] `generation_step` 增加引擎步标识。唯一约束与 `ON CONFLICT DO NOTHING` 的去重都等 PR-03 补上 `run_id` 列之后再做，见 D4。
- [ ] 预算预留在 step 开始前发生，键为引擎步标识，重放时复用。
- [ ] 运行记录写原 provider、端点、格式、请求头、模型、设置和凭据引用。

**You see.**

- [ ] 每个工具的真实调用与失败诊断。
- [ ] 无 authority 时写入被拒，拒绝原因可读。
- [ ] `edit` 在模拟崩溃后只执行一次，重复调用返回 `interrupted`。
- [ ] 预算耗尽后本轮停止，账本数字不重复。

**Verify, unit.** 工具输入校验、路径拒绝、幂等状态机、预算键。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 新建 App，生成一个 React 页面，读写文件并发布。保存截图。
- [ ] Lane 2. `edit` 执行中杀 Next 进程，恢复后不重复写入。保存 `agent_effect` 行与文件 hash。
- [ ] Lane 3. 每个工具至少真实调用一次，失败场景给出可读结果。保存日志。
- [ ] Lane 4. 预算耗尽后本轮停止，账本数字正确。保存 SQL 与截图。

**Verify, perf.** 同一 fixture 与旧引擎对比端到端生成 p95，上限为旧引擎的 120%，且不超过 180 秒。

**Review gate.** 工具行为变化，需要 operator 审截图与视频。

**Merge.** 独立核验通过并完成交互审阅后合并。

## 上下文、模型身份与计费 (PR-03)

**Depends on.** PR-02。

**Files.** `src/server/generation/agent/context.ts`、`summary.ts`、`model-record.ts`、`src/server/generation/generation-accounting.ts`、`src/server/billing/settlement.ts`、`tests/integration/agent/context.test.ts`、`tests/integration/agent/billing.test.ts`。

**Build.**

- [ ] 实现 `compact()` step，按 token 阈值生成摘要，写入 summary 消息并替换窗口，摘要计入模型预算。
- [ ] 运行记录保存原 provider、模型、设置和凭据引用，重启后按记录重建，不改投当前别名。
- [ ] 从模型 step 的 usage 写 `generation_step`，以引擎步标识幂等，重复执行不重复计费。
- [ ] 模型切换、价格变更和压缩都不重算历史步骤。

**You see.**

- [ ] 长对话触发压缩，摘要进入下一轮上下文，原始消息按策略保留。
- [ ] 重启后同一运行仍用原 provider 与原模型。
- [ ] 同一 fixture 的步骤数与 token 与旧引擎一致，差异有书面解释。

**Verify, unit.** 阈值、摘要替换、幂等计费、模型记录重建。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 长对话触发压缩，下一轮回答仍引用早期需求。保存截图与 token 记录。
- [ ] Lane 2. 运行中重启 Next 进程，模型身份不变。保存请求日志。
- [ ] Lane 3. 完成一次生成，账目与旧引擎对比。保存 SQL。

**Verify, perf.** 压缩后上下文不超过上限的 90%；压缩耗时不超过该轮模型调用耗时的 30%；同一引擎步只写一次账目。

**Review gate.** 压缩影响回答，需要 operator 审截图。

**Merge.** 独立核验通过并完成交互审阅后合并。

## 切换流式与历史读路径 (PR-04)

**Depends on.** PR-03。

**Files.** `src/server/generation/agent/stream.ts`、`src/app/api/[...path]/route.ts`、`src/server/generation/durable-engine.ts` 的读路径、`src/shared/chat-runtime.ts`、`src/app/app/chat/[id]/page.tsx`、`tests/e2e/**`。

**Build.**

- [ ] 模型调用使用 `WorkflowAgent.stream`，输出原生 `UIMessageChunk`，删除 AgentEvent 翻译层。
- [ ] `loadMessages` 改读 `agent_message`，返回 `UIMessage[]`，保持现有组件契约。
- [ ] 加按 runId 的重连端点，客户端断开不结束运行。
- [ ] 历史消息的工具 part 与附件 part 完整映射。

**You see.**

- [ ] 刷新页面后消息、工具状态和附件完整。
- [ ] 断开网络再恢复，流继续。
- [ ] 消息顺序与 id 稳定。

**Verify, unit.** 转录投影与 part 映射。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 生成中刷新页面，重新连上后继续。保存视频。
- [ ] Lane 2. 生成中关闭网络 10 秒再恢复。保存视频。
- [ ] Lane 3. 历史会话打开，工具调用与附件完整。保存截图。

**Verify, perf.** 首 token 延迟不高于旧引擎的 120%；100 条历史的消息打开时间不超过 2 秒。

**Review gate.** 交互变化，需要 operator 审视频。

**Merge.** 独立核验通过并完成交互审阅后合并。

## 崩溃恢复、输入与取消 (PR-05)

**Depends on.** PR-04。

**Files.** `src/server/generation/agent/inputs.ts`、`cancel.ts`、`recovery.ts`、`src/server/generation/control-store.ts`、`tests/integration/agent/recovery.test.ts`、`ask.test.ts`、`steer.test.ts`、`cancel.test.ts`。

**Build.**

- [ ] `loadInputs()` 在每次模型调用前按 `seq` 投递 `queued` 输入，写消息并改 `resolved`，水位只认连续前缀。
- [ ] `ask` 提问结束本轮，回答作为新输入开始新一轮，写门禁同步关闭与重开。
- [ ] `steer` 与 follow-up 走同一输入路径，在工具结果后、最终回复前进入上下文。
- [ ] 运行创建持久 `AbortController`，取消 hook 与 `Promise.race` 按 D8 实现。
- [ ] 工具在副作用前检查 `signal.throwIfAborted()`，构建工具 abort 时终止子进程。
- [ ] 重试耗尽后进入诊断状态，不自动重试。
- [ ] 恢复流程按 `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS` 在 60 秒内收束。
- [ ] 起两个 worker，确认同一 step 不会被执行两次，队列竞争不重复副作用。

**You see.**

- [ ] 重启后同一运行继续，不产生重复工具结果。
- [ ] 回答 `ask` 后从草稿继续。
- [ ] 取消后 1 秒内无新副作用，构建停止。
- [ ] 未结算输入不会发布。

**Verify, unit.** 输入状态机、连续前缀、取消状态、effect 行。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 生成中 `kill -9` Next 进程，重启后 60 秒内完成。保存视频与进程日志。
- [ ] Lane 2. 模型提问，回答后新一轮继续。保存截图。
- [ ] Lane 3. 生成中发送追加输入，顺序与水位数正确。保存消息序列。
- [ ] Lane 4. 取消生成，构建停止，账目只结算已完成步骤。保存 SQL、副作用时间戳与截图。

**Verify, perf.** 恢复延迟上限 60 秒，取消生效上限 1 秒，取消结算延迟上限 10 秒。

**Review gate.** 交互变化，需要 operator 审视频。

**Merge.** 独立核验通过并完成交互审阅后合并。

## 切换默认引擎并备份旧引擎数据 (PR-06)

**Depends on.** PR-05。

历史对话不迁移。operator 在 2026-11-05 确认这不是真实数据，可以丢弃；切换后旧会话为空，应用、草稿、已发布版本和账单不受影响，它们在 `paimeng_app` 的业务表里。

**Files.** `src/server/generation/agent/**`、`src/server/generation/durable-engine.ts`、`src/server/infra/config.ts`、`src/app/api/[...path]/route.ts`、新增迁移、`scripts/ops/backup-durable-tables.ts`。

**Build.**

- [ ] 切换前停止新运行，排空队列，对 `durable_schema` 等 9 张表做 `pg_dump` 备份，备份路径与校验和写进 PR。
- [ ] 默认切到 `agent`，保留按 App 回退到 `harness` 的开关一个发布周期。开关现在是全局的 `GENERATION_ENGINE`，本 PR 要给它加按 App 的覆盖（配置加迁移），回退开关指向的 App 仍由旧引擎接受生成。
- [ ] 默认路径不再写入旧引擎：只有回退开关指向的 App 会写，已受理的运行可以跑完。

**You see.**

- [ ] 切换后新建的会话在真实浏览器中完整可读，历史会话为空且页面不报错。
- [ ] 新生成默认走新引擎；只有回退开关指向的 App 写旧引擎。

**Verify, unit.** 开关切换后路由与默认值正确。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 切换前用旧引擎完成一次生成并发布，作为基线。保存截图。
- [ ] Lane 2. 切换后新生成走新引擎并发布。保存截图。
- [ ] Lane 3. 回退开关切回旧引擎，旧引擎仍能完成一次生成。保存日志。
- [ ] Lane 4. 打开一个切换前存在、切换后没有消息的旧会话，页面正常显示空历史。保存截图。

**Verify, perf.** 首屏不高于切换前的 120%；生成 p95 不高于 180 秒。

**Review gate.** 切换影响用户可见行为，需要 operator 审截图。

**Merge.** 独立核验通过并完成交互审阅后合并。

## 删除 pi-durable (PR-07)

**Depends on.** PR-06 稳定一个发布周期。

**Files.** 删除 `src/server/generation/durable/**`、`package.json` 中的 `@earendil-works/*`、`scripts/dev/durable-dev.ts` 中的 harness 分支、`src/app/api/durable/**`、旧 harness 测试与协议常量。新增迁移与 ADR。

**Build.**

- [ ] 删除三个 `@earendil-works` 依赖与全部 import。
- [ ] 删除 `harness-server.ts`、`storage-pg.ts`、`model-domain.ts`、`effect-gate.ts`、`harness.ts`、`protocol.ts`。
- [ ] 删除 `GENERATION_ENGINE` 开关与 harness 分支。
- [ ] 迁移删除 `paimeng_agent` 里的 `durable_schema` 等 9 张 SDK 表，明确排除 `workflow` 与 `workflow_drizzle`。执行前确认备份，删除需 operator 明确授权。
- [ ] 删除或改写 18 个 harness 集成测试，保留由新引擎覆盖的等价场景。
- [ ] 写 ADR，取代 ADR 0003，记录选择 AI SDK 加 Workflow 的理由、代价与回退边界。
- [ ] 更新 `docs/pi-durable-deployment.md` 与 `docs/provider-convergence.md` 的执行引擎描述。

**You see.**

- [ ] `grep -r "@earendil-works" src tests scripts package.json` 无结果。
- [ ] `npm ls` 无 pi-durable 相关包。
- [ ] 完整生成旅程通过。
- [ ] 旧 SDK 表在备份确认后删除，workflow schema 保留。

**Verify, unit.** 全量 unit 与静态检查。

**Verify, live.** 测试本身不足以验证。

- [ ] Lane 1. 新应用完整旅程。保存截图与视频。
- [ ] Lane 2. 切换前存在、切换后没有消息的旧会话，页面正常显示空历史。保存截图。
- [ ] Lane 3. 重启 Next 与 worker 后继续生成。保存日志。

**Verify, perf.** 与 PR-06 的数值对比，无回归超过 10%。

**Review gate.** 交互未变，但涉及数据删除。operator 审备份与删除清单。

**Merge.** 独立核验通过，operator 明确授权删除后合并。

## Close the program

- [ ] Every box above is checked with its evidence, or carries a written block with the reason it cannot be closed.
- [ ] The operator has the final report for each PR with its evidence paths and open limitations.
- [ ] `grep -r "@earendil-works" src tests scripts package.json` returns nothing.
- [ ] The old SDK tables are backed up and dropped with written authorization, and the `workflow` schema is intact.
- [ ] ADR 0003 is superseded by a new ADR that records the migration and its rollback boundary.

## Appendix A. Prototype evidence and open questions

PR-00 的原始产物在 `runtime/evidence/ai-sdk-migration/PR-00/`。已验证与未验证的边界如下。

- 已答。Workflow 5.4.0 与 Next 16.4.2、自托管 Postgres 16 共存，队列正常消费。
- 已答。手写 step 循环在 `kill -9` 后只重跑被中断的 step；已完成 step 的 attempt 保持 1。
- 已答。默认 job 锁配置下恢复停滞；30 秒配置下，重启后 28 秒完成。
- 已答。流是持久的，运行结束后可重连读回。
- 已答。取消只改运行状态，不中断在执行的 step。
- 已答（PR-01，不是 PR-00）。`WorkflowAgent` 可用：模型实例以槽位引用跨 step，在 step 内重建，见 D2。
- 未答。压缩与计费在 PR-03，ask、steer 与多 worker 在 PR-05。生产部署不在本计划范围内。真实 provider 已在 PR-01 的回显里跑过。

## Appendix B. Alternatives rejected

A 保留 pi-durable。被 operator 的产品与学习决定否决，不是被测量数据否决。
B AI SDK `ToolLoopAgent` 加自建持久层。控制力最强，但重建成本接近现有 9 张表和恢复语义。
D Temporal、Restate 或 Trigger.dev。持久化能力成熟，但引入第二套部署与运维模型，与当前单机产品不匹配。

## Appendix C. Risks

Workflow DevKit 的 API 处于快速演进期。风险与 pi-durable 同类。PR-00 记录了实际版本，PR-07 的 ADR 必须写明升级与回退策略。
step 结果进入事件日志，长工具输出会放大数据库。PR-00 测量了行数与字节，PR-02 的工具守卫给输出设上限。
workflow 代码要求确定性，时间和随机数受限。产品控制面调用必须放进 step，不能留在编排代码里。
在执行的 step 会被重放。`edit` 与构建不是天然幂等。`agent_effect` 在 PR-02 落地，`generation_step` 的幂等键在 PR-03。
取消是协作式的。工具不检查 signal 时仍会跑完；PR-05 必须逐个工具验证。
历史转录不迁移。切换后旧会话为空，页面必须正常显示空历史，见 PR-06 的 Lane 4。
两条引擎并存期间维护与测试成本翻倍。只允许存在到 PR-07，不能长期保留。
自托管 worker 的排空与重启语义由产品 launcher 负责。退出不排空会留下悬挂运行。
Postgres world 默认的 job 锁回收是 4 小时。不设置 `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS` 时，崩溃恢复会长时间停滞。
Workflow 的内部端点 `/.well-known/workflow/*` 由 Next 暴露。上线前必须确认它只接受队列调用，或由部署层限制来源。

## Appendix D. Sources

- AI SDK agent 与 workflow agent 文档，`https://ai-sdk.dev/docs/agents/workflow-agent`。
- AI SDK 循环控制，`https://ai-sdk.dev/docs/agents/loop-control`。
- Workflow 事件溯源与 step 语义，`https://deepwiki.com/vercel/workflow/1.2-key-concepts`。这是社区索引，不是上游官方原文，实施以安装版本的行为为准。
- Workflow 取消语义，本地包文档 `node_modules/workflow/docs/foundations/cancellation.mdx` 与 `how-it-works/cancellation.mdx`。
- Postgres world 配置，本地包文档 `node_modules/workflow/docs/configuration/worlds.mdx`。
- 仓库现状。`src/server/generation/durable-engine.ts`、`src/server/generation/durable/harness-server.ts`、`src/server/generation/durable/storage-pg.ts`、`src/server/generation/tools/**`、`src/server/models/adapters.ts`、`docs/adr/0003-sdk-as-engine.md`、`docs/pi-durable-deployment.md`。
- 现行计划。`docs/plans/app-runtime.md`，其中沙箱部分已由 operator 搁置，不在本计划范围。
