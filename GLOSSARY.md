# Paimeng AI Code Agent

面向非技术用户的 AI 应用生成平台：用户用自然语言描述需求，平台生成、验证、预览并发布网站。本词汇表描述当前产品上下文；旧平台实现只作为迁移来源。

## 产品与权限

**App**:
用户创建并拥有的应用，是生成、预览、部署和版本历史的单位。
_Avoid_: Application, project, site, 作品

**App chat**:
某个 App 在界面上的连续对话，跨越多次 Generation。
_Avoid_: conversation, session, thread, history

**Owner**:
创建 App 的用户。生成、取消、部署和下载是 Owner 的私有操作；管理员可以编辑或删除 App，但不能代替 Owner 执行这些操作。
_Avoid_: creator, author, user

**Admin**:
拥有用户、应用和模型配置管理权限的角色，不代表 App 的 Owner。
_Avoid_: administrator, superuser

**Featured app**:
首页精选案例中展示的 App。
_Avoid_: good app, recommended app

**Cover**:
用于在列表和部署结果中代表一个 App 的封面图片。
_Avoid_: thumbnail, screenshot

## 生成

**Generation**:
针对一个 App 的一次完整生成请求，从接收输入、产出候选、验证到发布或失败/取消。Generation 结束后不复用；新的用户输入产生新的 Generation。
_Avoid_: task, job, run, session

**Generation status**:
Generation 对外暴露的生命周期状态：generating、building、ready、failed、cancelled。ready 表示生成成功收束，不单独证明已经有可用预览。
_Avoid_: phase, state, step

**Generation phase**:
Harness 内部控制面使用的阶段：editing、checking、publishing、finished；它决定能否继续写入或发布，不是对外展示的 Generation status。
_Avoid_: generation status, public state

**Generation type**:
App 在存储层的产物类型：HTML、多文件静态站、Vue 工程或 React 工程；它保留历史数据与旧代码路径，不再出现在新建界面。「轻量静态页」与「React 厚架子」是 Starter，不是 Generation type。
_Avoid_: stack, code type, 技术栈

**Starter**:
新建 App 时在首页选择的起点，只有两个：轻量静态页（`html@1.0.0`，不需要构建）和 React 厚架子（`react-ts@2.0.0`，带布局、设计令牌、shadcn/ui 组件源码、路由与示例页面）。选择「自动选择」时平台先做轻量静态/构建类二分类，默认构建类，只有需求确实简单时才走轻量静态页。
_Avoid_: 技术栈, stack, generation type

**Template**:
新建 App 时复制进去的带版本源码骨架。Template 有版本，Generation type 没有；两者不能混用。`react-ts@2.0.0` 用 pnpm 与 `pnpm-lock.yaml`，是构建类 App 的默认模板；`react-ts@1.0.0`、`vue-ts` 与 `multi-file` 只保留解析与代码路径。
_Avoid_: stack, scaffold, preset

**Input**:
被 Generation 接收的一条用户消息，可以是开始、Steer、Follow-up 或对 Question 的回答。Input 有独立的投递和结算状态。
_Avoid_: message, prompt, request

**Steer**:
在当前 Generation 运行中、于步骤边界插入的输入；它不创建新的 Generation。
_Avoid_: interrupt, follow-up

**Follow-up**:
在当前 Generation 结束后用于开启下一轮 Generation 的排队输入。
_Avoid_: steer, retry, next message

**Question**:
Harness 在生成中向用户提出的澄清请求；当前 Generation 暂停，回答会以新的 Generation 从草稿继续。
_Avoid_: ask, prompt, clarification

**Candidate**:
Generation 在验证和发布前产出的源码与构建结果；尚未成为当前预览，新的输入可能使其失效。
_Avoid_: draft, delivery, result

**Execution**:
承载一次 Generation 的隔离运行，拥有自己的 Execution conversation、Workspace 和 Write authority。
_Avoid_: generation, run, task

**Attempt**:
计入 Generation 预算的一次模型、工具或构建调用；它记录该外部动作是否可能已经发生。
_Avoid_: call, try, retry

**Budget**:
一次 Generation 允许消耗的模型、工具、构建和修复次数上限；耗尽后拒绝继续，而不是延长 Deadline。
_Avoid_: quota, timeout

**Deadline**:
Generation 必须结束的绝对时间；恢复、Steer、Follow-up 和 Repair 都不会延长它。
_Avoid_: timeout, budget

**Repair**:
候选在可修复的构建或验证失败后，对同一 Generation 进行的有界返工；它不是新的 Generation。
_Avoid_: retry, regeneration

**Build**:
对生成源码的验证构建。模型在生成中请求的是 self-check build；平台在发布前执行的是 platform build。
_Avoid_: preview build, CI build

## 执行与可靠性

**Harness**:
常驻的执行服务，运行 Generation 并持有权威 Transcript；Web 层只负责鉴权和事件转发。
_Avoid_: worker, agent, Next server

**Transcript**:
Harness 中按顺序保存的用户、助手和工具记录，是 App chat 的权威来源；界面消息是它的投影。
_Avoid_: history, messages, log

**Execution conversation**:
一次 Execution 使用的 harness 对话上下文；它不同于用户看到的 App chat，也不跨 Generation 复用。
_Avoid_: session, thread, app chat

**Write authority**:
对单个 App 的生成状态进行写入的独占权限；同一时刻只有一个持有者，新持有者通过递增的 epoch 使旧执行失效。
_Avoid_: lease, lock, ownership

## 源码与产物

**Workspace**:
App 的源码工作区。App workspace 是 App 的持久源码目录；Execution workspace 是单次 Execution 的隔离副本，legacy 应用可能直接以 App workspace 作为回退基线。
_Avoid_: sandbox, checkout

**Draft**:
未发布 Generation 留下的已封存源码状态，供下一轮继续；它不是 Version，也不是当前预览。
_Avoid_: candidate, snapshot, autosave

**Source snapshot**:
一份不可变的源码树副本，用作 Generation 的基线或下载来源；来源可以是 Draft、Version 或 Template。
_Avoid_: backup, checkout, version

**Version**:
App 源码历史中一次已接受的提交，身份是完整的 commit SHA；它不是 Deployment，也不是 Delivery。
_Avoid_: release, snapshot, checkpoint

**Delivery**:
一个 Version 对应的不可变、已验证产物；预览、下载和 Deployment 都从 Delivery 取内容。
_Avoid_: deployment, build artifact, bundle

**Publish**:
接受 Candidate，记录其 Version 和 Delivery，并把该 Delivery 设为当前预览和下载来源；一次成功的 Publish 不创建公网 Deployment。
_Avoid_: deploy, release, save

**Preview**:
平台内展示当前 Delivery 的页面；它不是公网 Deployment。
_Avoid_: deploy preview, staging

**Deployment**:
把当前 Delivery 复制到公网地址形成的稳定副本，带有 Deploy key 和 Cover；它独立于 Preview 和 Version。
_Avoid_: publish, release, preview

**Deploy key**:
Deployment 的稳定公开标识，用于组成访问地址；同一 App 的后续部署复用同一个 key。
_Avoid_: slug, public key, release key

**Legacy app**:
从旧平台迁移、可能没有 Version 或 Delivery 的 App；它可能回退到 App workspace 提供预览和下载。
_Avoid_: old app, imported app

## 模型配置

**Provider model**:
某个提供商下已登记的模型，拥有稳定的 `pm_...` ID、上游请求名、能力和 Token price 版本；同名模型在不同提供商下是不同身份。业务槽位通过模型 ID 分配，调用参数属于槽位分配。见 [ADR-0006](paimeng-ai-code-agent/docs/adr/0006-model-config-document.md)。
_Avoid_: global model, model catalog, Model alias

**Model config document**:
PostgreSQL `app_config` 中 `key='model_config'` 的一份 `value` JSONB 文档，包含提供商、嵌套 Provider model、价格版本、槽位分配及迁移遗留价格。`revision` 控制并发编辑，`refresh_epoch` 控制立即刷新；服务端校验整份文档。
_Avoid_: provider table, model table, slot table, price table

**Model alias**:
历史术语：原先独立存储提供商、请求模型名与参数的别名配置。现已由 Model config document 中的槽位分配替代；内部 alias 类型和运行描述保留兼容含义，不作为另一份配置真值。
_Avoid_: Provider model, 当前模型配置实体

## 计费

**Usage**:
一次 Generation 实际消耗的模型 token 用量，可按步骤和模型归因；它折算成 Credit 之后才会成为 Charge。
_Avoid_: consumption, cost, 成本

**Credit**:
用户可见的用量单位，由 Usage 按 Provider model 的 Token price 折算而来。面额固定为 1 Credit = ¥0.01 = 1 分；它不可兑换成货币，也不能提现。
_Avoid_: token, 积分, points, 点数

**Token price**:
Admin 明确填写的人民币售价，单位为元 / 1M tokens，区分未命中输入、缓存命中输入和输出。存储为整数分 / 1M tokens；1 分 = 1 Credit，因此 ¥6 / 1M tokens 对应 600 Credit / 1M tokens。价格版本带 UTC 生效时间；改价只追加版本，已计价步骤使用不可变的账单快照。上游 USD 成本仅供参考，不通过倍率或汇率自动推导售价。
_Avoid_: Rate card, Markup, USD price, 按次价格

**Rate card**:
历史术语：原先独立维护的 Credit 费率表与管理入口，售价来源已被 Token price 替代，见 [ADR-0006](paimeng-ai-code-agent/docs/adr/0006-model-config-document.md)。`credit_rate_card` 旧表保留一个发布周期供回滚；`rate_card_snapshot` 等内部名称继续承载历史账单，不代表仍可维护独立费率表。
_Avoid_: 当前售价来源, pricing, tariff

**Markup**:
历史术语：[ADR-0004](paimeng-ai-code-agent/docs/adr/0004-credit-billing.md) 中上游峰时成本的 3 倍加成策略，已由明确填写的人民币 Token price 替代。当前售价流程没有倍率或汇率输入；该术语仅用于解释旧决策与旧账单。
_Avoid_: 当前定价规则, margin, 加价率

**Credit pool**:
Credit 的来源类别：配额池按周期发放并会重置，余额池由充值或发放而来且不重置。扣减总是先配额池、后余额池。
_Avoid_: 额度类型, account type

**Credit balance**:
Owner 当前可用的 Credit 总量，由配额池和余额池组成；它可以是负数，负值表示欠款，欠款状态下不允许开始新的 Generation。
_Avoid_: 额度, 余额, quota

**Credit grant**:
Credit 进入系统的唯一方式，分为购买、管理员发放和月度配额三种来源；只有购买计入 Overdraft 基数。
_Avoid_: 充值记录, topup, recharge

**Credit charge**:
一次生成结算：把该 Generation 的 Usage 折算成 Credit 并从 Credit balance 扣减的不可变记录。同一个 Charge 可以拆成多条按池区分的 Credit entry。
_Avoid_: 流水, 交易, bill, invoice

**Credit entry**:
Credit charge 下按 Credit pool 拆分的单条扣减分录。
_Avoid_: 明细, deduction

**Overdraft**:
允许 Credit balance 变成负数的上限：近 60 天 purchase 入账额的 2%，封顶 500 Credit；admin_grant 不计入基数，无 purchase 记录则为 0。透支线只是熔断线：结算中的欠款一旦超过它，正在运行的 Generation 被中止，然后按实际 Usage 扣减。
_Avoid_: 欠款额度, credit limit
