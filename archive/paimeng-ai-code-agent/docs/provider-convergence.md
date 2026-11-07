# 生成模型配置与 harness

状态：模型配置以 PostgreSQL `app_config` 中 `key='model_config'` 的一行 JSONB 为唯一来源，决策见 [ADR-0006](adr/0006-model-config-document.md)。生成由常驻 harness 执行，Next 负责鉴权、任务准入和 attach；生成模型默认来自管理端分配的 `codegen.default` 槽位。历史接入验收见 [provider-redis-convergence](plans/archive/provider-redis-convergence.md)，不代表当前存储结构。

字段校验、存储与错误码以 [model-document.ts](../src/shared/model-document.ts)、[model-config.ts](../src/shared/model-config.ts) 和 [store.ts](../src/server/models/store.ts) 为准。提供商连接与凭据、提供商下的模型与价格版本、槽位分配全部位于 `app_config.value`；旧配置表保留一个发布周期，不再参与运行期读写。

## 每轮模型准入

1. Next 调用 harness `POST /model`。harness 一致读取产品库模型配置，检查槽位所指模型与提供商已启用、格式和凭据来源有效，并固定这轮的模型描述。
2. 返回公开身份、图片能力、思考档位和不透明 binding token。响应不含密钥或密文。
3. Next 校验图片、附件与产品准入，再将 token 交给会话创建和 `/submit`。预检与提交之间改配置不会更换本轮绑定。
4. 后续运行重新解析配置；忙碌会话收到不同 token 时返回 409，不修改 provider 目录或会话配置。插话和修复轮沿用当前绑定。

未分配的槽位、已禁用的模型或提供商、密文无法解密、未允许的环境变量或不支持的 API 格式，会在任务落库前返回可读的 503。harness 可以在配置尚未完成时启动；不会因此静默选择另一模型。

## 来源优先级与凭据

| 来源 | 使用条件 | 凭据处理 |
| --- | --- | --- |
| harness 夹具 | 显式 `DURABLE_FAUX_FIXTURE=1` 或 `DURABLE_FAUX_MODEL=1` | 不访问真实上游；生产还要求 `ALLOW_TEST_FIXTURE=1` |
| 环境覆盖 | `DURABLE_MODEL_BASE_URL` / `_API_KEY` / `_ID` 三项完整设置 | 密钥只由 auth 回调读取；部分设置直接报错 |
| 产品模型域 | 默认路径，解析 `codegen.default` | inline 用 `decryptModelSecret`；env 经白名单检查后读取 `process.env` |

`npm run dev` 不再读取其他工具的模型配置文件。提供商 inline 密钥只以密文保存在 JSON 文档的 `providers[].apiKey.ciphertext`，解密使用 `MODEL_SECRET_KEY` 或已有的本地主密钥文件。明文不进入 `AliasModel`、HTTP 载荷、会话文档、日志或文件。

普通运行在内存 auth 闭包中保留准入时的 inline 密文，请求时才解密，因此轮换提供商密钥不会改变正在执行的运行。持久描述不包含该密文；重启恢复时按原提供商的凭据引用读取当前可用密钥。原凭据来源不存在时明确失败，不改用当前别名的提供商。

初始化（`npm run db:init-models`）只在文档提供商与槽位均为空、`revision` 与 `refreshEpoch` 都为 0 时，用 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 建一个提供商、一个模型和两个必需槽位分配，已有配置不覆盖。初始化不猜售价，模型的 `prices` 初始为空，Admin 必须补齐人民币单价；初始化成功不等于已具备可用价格。初始化之后 DB 是唯一来源：读取失败不等于文档空，不能借此回退环境变量。两个必需槽位是 `codegen.default`（生成）与 `route.classify`（应用类型分类），同一模型可以分配给多个槽位。

密钥两种来源：`apiKeySource='env'` 只存引用名，默认允许 `AI_API_KEY`，其余需列进 `MODEL_API_KEY_ENV_ALLOWLIST`；`apiKeySource='inline'` 的明文不落库，AES-256-GCM 加密后只存密文，主密钥取自 `MODEL_SECRET_KEY`，未设置时自动生成 `runtime/model-secret.key`（0600）。该文件丢失后已存密钥无法解密，必须在管理端重输。接口只返回 `apiKeySource` 与当前实例是否已配置。

地址只允许无内嵌凭据、无查询、无片段的 HTTP(S)。`http:` 对本机与局域网字面量（`localhost`/`*.localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`、`fe80::/10`、`fc00::/7`）直接放行，判定只看字面量、不做 DNS 解析，也**不含** `169.254/16`；其余 origin 需写进 `MODEL_INTERNAL_BASE_URL_ORIGINS`。

## 协议与思考设置

| 产品 API 格式 | pi-ai API | 地址约定 |
| --- | --- | --- |
| `openai-chat` | `openai-completions` | `{baseUrl}/chat/completions` |
| `openai-responses` | `openai-responses` | `{baseUrl}/responses` |
| `anthropic-messages` | `anthropic-messages` | 产品地址末尾的 `/v1` 由适配器归一，避免重复 `/v1/v1/messages` |

请求使用提供商自定义 headers、所选模型的上游请求名和槽位分配中的 reasoning，输出预算来自槽位设置。通用 OpenAI Chat 不附带 DeepSeek 的 thinking 字段；显式设置 `thinkingSwitch` 时按保存值强制开启/关闭。关闭优先于槽位 reasoning，开启且未指定强度时只发送开启指令。

协议选项按格式白名单化：`openai-chat` 支持布尔项 `includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent` 与命名项 `thinkingSwitch`（`none`/`enabled`/`disabled`，非 `none` 时在请求体追加 `thinking:{type}`）；另外两种格式没有可配置选项，提交不支持的选项会被拒绝。新增格式或适配器仍需改代码和部署，DS 里不存可执行脚本。

`settings.reasoning`（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，缺省不传）由适配层的自定义 middleware 注入，映射如下：

| API 格式 | 上游字段 | 说明 |
| --- | --- | --- |
| `openai-chat` | `reasoning_effort: <level>` | `@ai-sdk/openai-compatible` 的既有映射；DeepSeek 还可用 `thinking` 开关 |
| `openai-responses` | `reasoning: {effort: <level>}` | 必须同时打开 `forceReasoning`，否则 SDK 因模型名未知丢弃该字段 |
| `anthropic-messages` | `thinking: {type: 'enabled', budget_tokens}` | 预算按 `max_tokens` 比例换算，最低 1024 |

上游是否接受某个等级由上游决定：本项目只做枚举校验，不按厂商收窄。

DeepSeek 的 Responses 格式把思考文本放在 `output[].content`（`reasoning_text`）、流式事件叫 `response.reasoning_text.delta`，而 AI SDK 只认 `response.reasoning_summary_text.*` 与 `summary`；非流式还缺 schema 要求的 `annotations`。所以该格式的响应先经 `src/server/models/responses-reasoning.ts` 改写（只改 `delta` 事件并映射 `content_index`→`summary_index`，`.done` 透传；非流式把 reasoning `content` 复制成 `summary` 并补空 `annotations`）再交给 SDK。Chat 格式不需要这层，`reasoning_content` 由 `@ai-sdk/openai-compatible` 原生解析。

自定义请求头存在文档的 `providers[].headers`，与协议选项分开：名称须为 RFC token、大小写不敏感去重，值须是首尾无空白的可打印/扩展 ASCII（可编码为 ByteString），最多 32 条、名称 128、值 1024 字符。`authorization`、`proxy-authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、`host`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`keep-alive`、`proxy-authenticate`、`cookie`、`set-cookie` 属系统生成，提交即拒绝。适配层必须把这组头并进每次调用的参数头（`src/server/models/adapters.ts` 的 middleware），因为 AI SDK 每次调用都会注入自己的 `user-agent`，只配 provider 会被覆盖；生成、流式、结构化与探测共用同一组头，并在任务绑定时冻结。

探测（`POST /api/model/admin/provider/models`）按当前填写或已保存的密文实时请求上游 `GET {baseUrl}/models`：`openai-chat`/`openai-responses` 用 `Authorization: Bearer`，`anthropic-messages` 用 `x-api-key` + `anthropic-version`；10 秒超时、不跟随重定向、`cache-control: no-cache`、最多 1000 条、结果不落库。错误回显前先对密钥值与自定义头值脱敏。它只证明地址与密钥能列模型，不代表所选模型与格式可推理；「保存成功」同样只代表本地校验通过。

## Admin 配置流程与人民币单价

1. 在 `/admin/models` 配置提供商地址、格式、凭据与请求头；获取上游 `/models` 候选或手动登记模型。获取列表不自动新增模型、配置价格或切换槽位。
2. 在提供商下登记模型，确认上游请求名、显示名和能力。每个模型有稳定 `pm_...` ID；同一提供商内请求名唯一，不同提供商的同名模型独立定价。上游请求名创建后不可改，改名需新建模型并重新分配槽位。
3. 给模型明确填写未命中输入、缓存命中输入、输出三档人民币单价，界面单位是元 / 1M tokens（最多两位小数），服务端接收整数分 / 1M tokens。三档不能全为 0；可选的上游 USD 数据仅供参考，不提供倍率或汇率推导。
4. 保存单价追加 `prices[]` 版本，服务端生成 `version` 与 UTC `effectiveAt`。当前 Admin 入口按保存时刻生效，不能回填过去价格或预约未来价格。迁移带入的未来版本仍可读，计费到生效时间才应用。模型行展示当前价与历史版本，不再维护独立 Rate card 页面。
5. 在「模型分配」中选择模型，并填写该槽位的采样、输出预算与思考参数。新分配要求提供商/模型启用、能力满足且有当前生效单价；缺价先补价。能力属于模型，不在槽位重复声明。
6. 刷新核对 DB revision、模型价格和分配结果；并发保存返回 409 时重新加载后再编辑。需要跨进程立即刷新模型绑定时使用「立即生效」。这不会改变正在执行的绑定或历史已计价步骤。

清空只允许可选槽位；必需槽位必须改指另一个可用模型。仍被槽位引用的模型不能停用，提供商下仍有模型则不能删除。修改提供商启用状态或模型能力后，已有分配可能被标为不可用，Admin 需修复后再准入；不能把文档校验通过当成所有上游已可推理。

价格按每步发生时刻解析，不固定在生成开始时；已计价步骤保留自己的账单快照，切换模型或改价不重算历史。迁移、旧缺价与回退见[计费运行说明](billing-operations.md#模型配置迁移与回退)。

## 配置生效

每个进程持有不可变快照（`revision`、`refreshEpoch`、加载时间、组装后的别名注册表）。默认 TTL 5000 ms，从一致读事务开始计时，不是从加载完成计时，所以慢查询不会顺延有效期；没有请求时不定时读整表。管理端列表始终直接读 DB，显示 DB 版本与该实例缓存版本，两者含义不同。

手动「立即生效」不能只清本进程缓存，否则请求落到别的实例仍用旧配置：每次业务模型解析前读一次状态行的 `refreshEpoch`（轻量检查不进 TTL），管理员提交时锁状态行、校验 `expectedRevision` 与完整配置、递增 `refreshEpoch`。其他实例在下次解析时发现序号变化，跳过 TTL 等完整快照加载完成。

加载 `app_config` 行时，在同一一致性读事务中读取文档与版本并完成校验；新快照解析校验完成后一次替换引用，不原地改旧注册表；同进程并发刷新复用一个加载 Promise，且不因单个请求取消而中止。

故障分级：冷启动无快照且读不到配置 → 503，不凭空换模型；TTL 到期但 DB 暂时不可读、且没观察到更高 `refreshEpoch` → 最多沿用距上次一致读 60 秒内的旧快照（失败后退避约 1 秒，只暂缓整份重载，序号探测照常），超时后拒绝新调用；已看到更高 `refreshEpoch` 却加载失败 → 本次 503，不能用旧配置假装生效。上游鉴权失败、模型不存在、429 或协议错误属于调用故障，沿用旧快照无用，不自动切换别名、不重放已执行工具的生成。

配置写入在事务中锁 `app_config` 的 `model_config` 行、检查 `expectedRevision`、校验完整候选文档后一次替换 `value` 并递增 `revision`。`applyImmediately` 额外递增 `refresh_epoch`；单独「立即生效」只增 epoch，不改内容版本。版本以十进制字符串传输，避免 JS 大整数精度丢失。版本冲突返回 409，载荷或引用校验失败返回 400，DB 不可用返回 503。JSONB 内部的唯一性和引用由服务端校验，不能依赖旧表的外键。

## 重启与记账

每轮公开描述保存在 pi-durable 会话文档 `app.run-model`：原 providerId、模型引用、地址、API 格式、请求头、设置、能力和凭据引用。没有明文或密文，不新增产品表。

恢复不重新解释当前别名：即使别名已改指 P2，旧运行仍按原 P1 的描述重建。已结束模型循环的会话也可通过只读 `GET /model?conversationId=` 返回原身份，支持产品最终构建阶段的接管。显式环境覆盖恢复时同样使用持久引用里的模型与地址。

账目继续记录槽位兼容别名、产品 providerId 与模型名，按现有提供商/名称兼容键解析 JSON 价格；不宣称已实施被替代计划中的 `generation_step.provider_model_id`。已应用价格保存在 `credit_charge.rate_card_snapshot`，旧字段名不代表仍读取旧费率表；上游请求元数据另存。实时助手消息使用合法 SDK metadata 的 generationId 对应用量，刷新后的历史使用原助手条目 id。

## 类型分类仍在 Next

`createApp` 在创建应用前调用 `route.classify`，只返回一个结构化类型，不需要建立生成会话。因此保留现有 AI SDK 路径及同一模型注册表。它沿用 5 秒 TTL / refresh epoch；生成则每轮直接读取产品配置。

## 实现与验证落点

- 运行描述、凭据与适配：`src/server/generation/durable/model-domain.ts`。
- 公开 HTTP schema：`src/shared/durable-model.ts`。
- 准入、持久化与恢复：`src/server/generation/durable/harness-server.ts`。
- 产品任务、attach、记账与实时 metadata：`src/server/generation/durable-engine.ts`。
- 请求契约单测：`tests/unit/models/durable-model-domain.test.ts`。
- 热更新、忙碌拒绝、凭据隔离与重启：`tests/integration/harness/model-config.test.ts`。
