# Paimeng 系统设计

本文是系统设计的唯一来源，定义架构、模块边界、信任边界、一致性规则、前后端接口契约和范围边界。术语以根目录 `GLOSSARY.md` 为准；关键取舍的理由记录在 `docs/adr/`。

## 1. 目标与约束

**目标**：用户用一句中文描述创建应用，Agent 写出可运行的前端源码，平台安装依赖、验证并实时预览；用户可以在同一应用中连续修改、随时停止。

**不可违反的约束**：

- 生成的代码不可信。它不能接触宿主机、主站、数据库、密钥、其他应用或互联网。
- 一次运行的结果只能以平台验证为准，不以模型自述为准。
- 任何终态只写入一次；重启、断连、取消和完成竞争时不能出现两个结果或永久“进行中”。
- 资源不足或依赖不可用时明确拒绝，不排队、不降级为不安全的实现。

**部署前提**：单台 Linux 主机，Docker Engine，单个后端实例，一个 OpenAI Responses 兼容的模型网关。

## 2. 系统上下文

```text
浏览器
├── 主站来源      http://paimeng.localhost:8080
│   └── Nginx ─► Vue 主站
│            └─ /api ─► NestJS 后端（127.0.0.1:8123）
└── 预览来源      http://app-{appId}.preview.paimeng.localhost:8080
    └── Nginx ─► NestJS 预览网关 ─► 该应用的预览环境

NestJS 后端（宿主机进程，唯一能调用 Docker 的组件）
├── PostgreSQL 16   权威状态：用户、应用、对话、运行、运行详情
├── Redis 7         session、应用限流、单实例锁、维护锁
├── 模型网关         Responses 接口
└── Docker CLI      预览环境与任务容器
    └── registry 中继（监听在安装网络网关上，只转发 npm）
```

| 组件 | 职责 | 不负责 |
|---|---|---|
| Nginx | 按 Host 分流主站与预览，关闭流式响应缓冲 | 鉴权、选择上游容器 |
| Vue 主站 | 交互、渲染流式消息、展示预览 iframe | 判定运行成败、访问 iframe DOM |
| NestJS 后端 | 鉴权、运行编排、工具执行、容器调度、预览网关 | 执行生成的代码 |
| PostgreSQL | 所有需要一致性的状态与约束 | 临时计数 |
| Redis | 有过期语义的共享状态 | 并发上限等一致性约束 |
| 容器 | 安装、检查、构建、运行生成的代码 | 访问平台的任何资源 |

## 3. 后端模块架构

```text
接入层      auth   apps   conversations   runs   preview   health
              │      │          │           │       │
编排层        │      │          │         agent ── tools ── skills
              │      │          │           │       │
执行层        │      └──────────┴──────► runtime（文件、依赖、Docker、应用锁）
              │
基础设施    config   db   redis   common            startup（启动收尾）
```

- **依赖方向**：上层依赖下层，下层不依赖上层。`runtime` 只依赖 `config` 与 `common`，不知道运行、对话或用户。`skills` 不依赖任何业务模块。
- **控制器**只做参数校验、取当前用户和调用 service；工具循环、Docker 调度和文件操作不进入控制器。
- **`runs`** 拥有运行的生命周期：创建事务、流、取消、唯一的收尾函数、启动时收尾。
- **`agent`** 拥有一次运行内的模型循环、验证与修复决策，通过回调向 `runs` 报告阶段与事件。
- **`tools`** 是模型能力的唯一入口，负责授权、预算、取消检查和结果截断；模型不能直接调用 `runtime`。
- **`runtime`** 是唯一接触应用目录和 Docker 的模块；所有 Docker 命令带固定参数、超时和本项目标签。
- **`preview`** 拥有预览授权与网关，按应用 ID 查找上游。
- **`startup`** 在接受请求前完成单实例锁、遗留运行收尾和遗留容器核对。

当前存在的反向引用：`agent`、`tools` 和 `conversations` 引用 `runs` 下的运行详情服务或类型；`apps` 与 `preview` 互相引用。新代码不要再增加跨层反向依赖；需要时把共享部分下沉到独立模块。

## 4. 领域模型与数据所有权

```text
用户 1 ─ n 应用
应用 1 ─ 1 对话 1 ─ n 消息
应用 1 ─ n 运行（同一时刻最多 1 个进行中）
运行 1 ─ 2 消息（用户、助手）
运行 1 ─ n 会话记录
运行 1 ─ 1 计划、n 活动、n 变更文件、n 验证日志
```

| 数据 | 读者 | 存放 |
|---|---|---|
| 消息（`UIMessage`） | 用户 | `messages` |
| 会话记录：完整模型输入、工具调用与结果 | 模型（重建上下文）、审计 | `agent_session_entries` |
| 运行详情：计划、活动、变更、验证日志 | 用户 | `run_*`、`content_blobs` |
| 源码、依赖、构建产物、任务日志 | 容器、文件工具 | 后端 `runtime/` 下按应用分目录 |

消息与会话记录分开存放，见 [ADR-0009](adr/0009-separate-ui-messages-from-session-entries.md)。所有资源都归属于某个应用，所有查询都校验应用的所有者。

## 5. 运行

### 5.1 生命周期

```text
运行状态：running ─► completed | failed
          running ─► cancelling ─► cancelled
阶段：    prepare ─► generate ─► install ─► validate ─►（repair ─► generate …）─► finish
助手消息：streaming ─► completed | failed | cancelled
```

1. **创建**：单个事务内完成校验、加锁，写入用户消息、运行、助手消息占位和会话记录，提交后才开始流式响应。
2. **生成**：AI SDK 驱动模型与工具循环，见 [ADR-0001](adr/0001-ai-sdk-with-plain-ts-orchestration.md)。
3. **验证**：本轮有源码变更时，平台依次执行 `source`、`manifest`、`install`、`typecheck`、`build`、`preview` 检查。
4. **修复**：验证失败时把错误写回同一对话；首次验证之外最多修复 3 次。
5. **收尾**：唯一的收尾函数用条件更新写入终态，事务提交后才发送最终流事件。

是否安装、检查和构建由实际的 `package.json` 与脚本决定，与生成类型无关，见 [ADR-0006](adr/0006-code-gen-type-is-a-label.md)。

### 5.2 预算

所有阶段共享同一份预算，修复不会重置：

| 预算 | 默认值 |
|---|---|
| 模型步骤 | 100 |
| 运行总时长 | 30 分钟 |
| 单次模型请求 | 120 秒，关闭 SDK 隐式重试 |
| 安装 / 构建 / 预览启动 | 5 分钟 / 3 分钟 / 60 秒 |
| 单次工具输出 | 50 KiB，在产生时截断 |
| 上下文 | `AI_CONTEXT_WINDOW_TOKENS` 减去输出预留，超出即失败，见 [ADR-0008](adr/0008-no-automatic-context-summarization.md) |

### 5.3 取消与故障

- 用户取消或流异常断开都会进入 `cancelling`；每次文件落盘前都重新检查取消信号。
- 已写入的文件保留，不撤销。
- 无法确认任务容器已经停止时，应用进入执行阻塞，在清理核对通过前不能开始新运行。
- 后端重启后不续跑，遗留运行一律收尾为失败，见 [ADR-0005](adr/0005-single-instance-no-resume.md)。

## 6. 一致性与并发

| 规则 | 保证方式 |
|---|---|
| 同一应用最多一个进行中的运行 | `agent_runs` 上针对 `running` / `cancelling` 的部分唯一索引 |
| 每个用户最多 5 个应用同时运行 | 按用户 ID 的事务级 advisory lock 加计数 |
| 重复提交不产生第二个运行 | `(app_id, client_request_id)` 唯一索引 |
| 应用状态变更与删除互斥 | 应用行锁与进程内应用锁 |
| 会话记录顺序 | `(conversation_id, seq)` 唯一索引 |
| 每个应用每分钟最多 10 次发送 | Redis 滑动窗口；Redis 不可用时拒绝 |

一致性约束放在 PostgreSQL，不放在 Redis 或进程内存，见 [ADR-0004](adr/0004-concurrency-limits-in-postgres.md)。

## 7. 信任边界

```text
信任   ┌ 后端进程、PostgreSQL、Redis、技能文件
       │
半信任 ├ 已登录用户：只能操作自己的应用
       │
不信任 ├ 模型输出：只能通过工具操作当前应用目录
       ├ 生成的代码：只在容器内运行
       └ 预览页面：独立来源，不能读写主站
```

### 7.1 主站

- session 存在 Redis，cookie 为 host-only、HttpOnly、SameSite=Lax，HTTPS 下启用 Secure；登录时更换 session ID。
- 接口默认要求登录，公开接口显式声明；修改类请求校验 `Origin`。
- 聊天 Markdown 以 `html: false` 渲染。

### 7.2 模型与工具

- 文件工具只能访问当前应用目录，拒绝绝对路径、`..`、软链接和特殊文件；覆盖、编辑、删除前必须读取并核对版本。
- 锁文件、包源和 pnpm 配置、`node_modules`、`dist` 和缓存由平台管理，工具不能修改。
- 技能只读；通用文件工具不能访问技能目录。
- 修改源码或依赖前必须先提交计划。

### 7.3 依赖

- 只允许白名单内的 16 个直接依赖，检查覆盖全部依赖声明，拒绝 Git、tarball、本地路径、别名和 workspace 来源。
- 安装任务只拿到过滤后的 manifest，不挂载源码，默认禁止安装脚本；只能经 registry 中继访问 npm。

依赖策略见 [ADR-0007](adr/0007-dependency-allowlist-and-registry-relay.md)。

### 7.4 容器

- 容器以非 root 运行，根文件系统只读，去除全部 capabilities，启用 no-new-privileges 和默认 seccomp。
- 源码和依赖只读挂载，输出、临时目录和缓存使用单独的可写位置。
- 不挂载 Docker socket，不发布宿主机端口，不注入后端环境变量、session 或模型密钥。
- 预览环境与构建任务所在网络没有出口，也不能访问主站、数据库或其他应用。
- 后端只操作带 `paimeng.project=paimeng-ai-code-mother` 标签的 Docker 对象，不执行无范围的 prune。

隔离方案见 [ADR-0002](adr/0002-docker-isolation-via-cli.md)。

### 7.5 预览

```text
主站签发 60 秒单次票据 ─► 预览来源用 POST 换取 host-only HttpOnly cookie（15 分钟）
  ─► 每个页面、资源和 WebSocket 请求都校验 cookie、主站 session、所有者和应用状态
  ─► 网关按应用 ID 转发，不转发平台 cookie
```

- 每个应用使用独立来源，主站与预览不共享 cookie，也不访问彼此的 DOM。
- 预览响应设置 CSP，只允许主站嵌入，并禁用 service worker。
- 退出登录、删除应用或授权过期时，关闭已建立的 WebSocket。

预览方案见 [ADR-0003](adr/0003-per-app-preview-origin.md)。

## 8. 资源边界

| 资源 | 默认上限 |
|---|---|
| 活跃预览环境（整机） | 5 个，超出直接拒绝 |
| 预览环境 | 512 MiB、1 CPU、128 个进程 |
| 任务容器 | 1536 MiB、1 CPU、128 个进程 |
| 整机容器内存预算 | 8 GiB，并要求宿主保留可用内存和磁盘 |
| 单文件 / 源码总量 / 文件数 | 1 MiB / 100 MiB / 5000 |
| 每个应用的任务日志 | 10 MiB |
| 每个应用的运行详情 | 1 GiB |
| 预览空闲回收 | 无运行且 15 分钟无人查看 |

所有上限都可以通过环境变量配置，变量清单见根目录 `.env.example`。

## 9. 删除

1. 在应用锁内确认没有进行中的运行，把应用标记为 `deleting`。
2. 立即禁止发送消息和预览，撤销预览授权并关闭 WebSocket。
3. 停止容器，删除专属依赖、缓存和源码，最后在事务中删除对话、运行和运行详情。

清理失败时按 5 秒、30 秒、2 分钟、之后每 10 分钟重试，重启后继续。

## 10. 接口契约

本节是前后端唯一的接口契约。字段级 schema 以仓库中的 `paimeng-ai-code-mother-backend/openapi.json` 为准：它由后端 zod schema 离线导出（OpenAPI 3.1），前端 `src/api/generated/` 由 openapi2ts 从同一文件生成，`pnpm contract:check` 保证两者不漂移。本节只描述 schema 表达不了的行为、约束和时序。

### 10.1 通用约定

- 前缀为 `/api`。除注册、登录、退出和健康检查外，所有接口都要求登录（session cookie `pm_sid`）。
- 普通接口返回 JSON 包络 `{ code, message, data }`，成功时 `code` 为 0，HTTP 状态码统一为 200（包括 `POST`）；失败时 `message` 是中文原因，`data` 为 `null`，同时返回对应的 HTTP 状态码。
- 用户、应用使用数值 ID，运行使用 UUID，时间为 UTC ISO 8601 字符串。
- 修改类请求必须携带 `ALLOWED_ORIGINS` 内的 `Origin`，否则返回 403。
- 应用、对话、运行、预览相关接口只允许应用所有者访问。

| code | HTTP | 含义 |
|---|---|---|
| 0 | 200 | 成功 |
| 40000 | 400 | 参数或状态不允许 |
| 40100 | 401 | 未登录或登录已失效 |
| 40300 | 403 | 无权访问该资源 |
| 40400 | 404 | 资源不存在 |
| 40900 | 409 | 冲突：运行中删除、已有进行中的运行、重复请求内容不一致 |
| 42900 | 429 | 限流 |
| 50000 | 500 | 服务内部错误 |
| 50300 | 503 | 依赖不可用（Redis、Docker 等） |

新增错误码时同步修改后端 `src/common/api.ts` 和本表。

### 10.2 身份

| 接口 | 请求 | 行为 |
|---|---|---|
| `POST /user/register` | `userAccount`、`userPassword`、`checkPassword` | 账号 4–64 字符，密码 8–128 字符且两次一致；成功后直接登录 |
| `POST /user/login` | `userAccount`、`userPassword` | 成功后更换 session ID |
| `POST /user/logout` | 无 | 销毁 session，返回 `true` |
| `GET /user/get/login` | 无 | 返回当前用户 |

注册、登录和查询当前用户都返回 `LoginUserVO`，字段见 `openapi.json` 中的 `BaseResponseLoginUserVO`。

### 10.3 应用

| 接口 | 请求 | 行为 |
|---|---|---|
| `POST /app/add` | `initPrompt` | 只创建应用和对话，不调用模型、不开始运行；名称取初始提示词前 12 个字符；返回 `{ id }` |
| `POST /app/my/list/page/vo` | `pageNum`（默认 1）、`pageSize`（默认 12，最大 50）、`sortField`（`createTime` / `updateTime` / `id` / `appName`）、`sortOrder`（`asc` / `desc`） | 只返回 `active` 应用；返回 `{ records, total, current, pageSize }`。`GET /app/my/list/page` 是兼容别名 |
| `GET /app/get/vo?id=` | 无 | 返回 `AppVO` |
| `POST /app/update` | `id`、`appName`（1–50 字符） | 改名 |
| `POST /app/delete` | `id` | 有进行中的运行时返回 409；否则进入第 9 节的删除流程 |

`AppVO` 的字段见 `openapi.json` 中的 `BaseResponseAppVO`。其中 `currentRun` 只包含进行中的运行，没有时为 `null`；`codeGenType` 只用于展示，见 [ADR-0006](adr/0006-code-gen-type-is-a-label.md)。

### 10.4 对话历史

`GET /chatHistory/app/:appId?cursor=&pageSize=` 按时间正序返回 `{ records, nextCursor, hasMore }`。`pageSize` 默认 20，最大 50；`cursor` 是不透明游标，`nextCursor` 为 `null` 表示没有更多。

每条记录的字段见 `openapi.json` 中的 `BaseResponseChatHistory`。`content` 是 AI SDK `UIMessage`，消息 ID 固定为 `user:{runId}` 和 `assistant:{runId}`，`parts` 按实际发生顺序排列，只合并连续的文本增量：

| part | 内容 |
|---|---|
| `text` | 用户或助手正文 |
| `dynamic-tool` | 工具名、调用 ID、状态和安全摘要后的输入输出，不含文件全文或完整工具输出 |
| `data-plan` | 计划的一次修订快照 |
| `data-validation` | 一个验证检查项的状态 |

完整的工具输入输出只保存在会话记录中，不通过接口返回。

### 10.5 运行

**`POST /app/chat/gen/code`**：请求 `{ appId, message, clientRequestId }`，`message` 为 1–1000 字符，`clientRequestId` 由前端生成、在应用内唯一。并发与防重规则见第 6 节：重复的 `clientRequestId` 直接返回已有运行的流，内容不同返回 409；超过限流返回 429。

响应是 AI SDK UI Message Stream（`text/event-stream`），每个 `data:` 是一个 `UIMessageChunk`，每 15 秒发送注释心跳 `: ping`，最后发送 `data: [DONE]`，不发送模型 reasoning。

- 写入消息的 chunk：`text-*`、`tool-input-available`、`tool-output-available`、`tool-output-error`、`data-plan`、`data-validation`。
- 只用于运行控制、不写入消息的 transient chunk：

| chunk | data |
|---|---|
| `data-run-started` | `{ runId, status }` |
| `data-phase` | `{ runId, phase }` |
| `data-model` | 模型进度：等待响应或正在接收工具参数、已接收字节数、网关返回的 token 用量；不含参数或推理原文，每秒最多更新一次 |
| `data-preview` | `{ status, kind, url?, error? }` |
| `data-run` | 终态：`{ runId, status, errorCode, errorSummary, stepCount, repairCount, detailsStatus, detailsError, changes }` |

只有最后一个 `data-run` 的 `status` 为 `completed` 才表示成功。浏览器离开页面或连接异常关闭会触发取消，收到终态后的正常关闭不会触发取消。

**`GET /app/run/status`**：参数为 `runId`，或在首个流事件丢失时用 `appId` 加 `clientRequestId`。返回运行状态、阶段、步数、修复次数、错误码、时间和 `detailsStatus`（`pending` / `ready` / `incomplete`）。

**`POST /app/run/cancel`**：请求 `{ runId }`。进行中的运行转为 `cancelling`，终止模型请求和任务容器，5 秒内不再产生新的文件或验证副作用，最终进入 `cancelled`。对已经结束的运行重复取消直接返回。

运行终态的 `errorCode` 与 HTTP 包络错误码相互独立：

| errorCode | 含义 |
|---|---|
| `CANCELLED` | 用户取消或连接断开 |
| `INTERRUPTED` | 后端重启时运行仍在进行，见 [ADR-0005](adr/0005-single-instance-no-resume.md) |
| `NO_CODE_PRODUCED` | 连续两轮生成都没有源码变更 |
| `VALIDATION_FAILED` | 修复次数用尽，或验证失败后没有新的修复变更 |
| `STEP_LIMIT` / `RUN_TIMEOUT` | 模型步骤或运行总时长用尽 |
| `MODEL_TIMEOUT` | 单次模型请求超时 |
| `MODEL_ERROR` | 模型网关或流内错误，立即终止上游请求 |
| `MODEL_OUTPUT_LIMIT` / `MODEL_OUTPUT_INVALID` | 输出被截断或工具参数无效，在没有成功文件变更期间累计 3 次 |
| `CONTEXT_BUDGET_EXCEEDED` | 平台估算上下文超限，未发送请求，见 [ADR-0008](adr/0008-no-automatic-context-summarization.md) |
| `CONTEXT_LIMIT_REJECTED` | 网关以上下文超限拒绝请求 |
| `SKILL_REGISTRY_ERROR` | 技能注册表加载失败 |
| `DETAILS_BASELINE_FAILED` | 运行开始前的源码快照创建失败 |
| `INTERNAL_ERROR` | 其他内部错误 |

取消或出错前已经输出的文字都会保留。只读文件或只回复文字的轮次不进入验证。

### 10.6 运行详情

以下接口都是只读的：

| 接口 | 内容 |
|---|---|
| `GET /app/run/details?runId=` | 运行、计划、验证检查项、活动水位和变更摘要 |
| `GET /app/run/activities?runId=&afterId=&limit=200` | 按活动 ID 分页读取活动 |
| `GET /app/run/changes?runId=&cursor=&limit=100` | 按文件分页读取变更 |
| `GET /app/run/change?runId=&fileId=&cursor=&limit=200` | 读取由不可变快照生成的单文件 unified diff |
| `GET /app/run/validation/log?runId=&attempt=&check=` | 读取一次验证尝试中单个检查项的日志 |

- 变更按“运行开始前快照 → 停止写入后快照”计算；取消和失败的运行也会记录已落盘的文件。没有快照的旧运行返回 `detailsStatus: "incomplete"`，不补造 diff。
- 计划步骤的状态由 Agent 更新，平台的验证结果单独记录。
- 新运行开始前会检查运行详情配额并预留两份源码上限的空间；配额不足或无法计量时拒绝新运行，不调用模型，也不删除旧历史。

### 10.7 预览

| 接口 | 请求 | 行为 |
|---|---|---|
| `POST /app/preview/start` | `appId` | 构建型应用启动或复用预览环境，静态应用直接可用；返回 `{ status, error, url }` |
| `GET /app/preview/status?appId=` | 无 | 返回 `{ status, kind, url, lastError }`，不启动容器 |
| `POST /app/preview/access` | `appId` | 返回 `{ ticket: { ticket, expiresIn }, url, expiresInSeconds }`，票据 60 秒内有效且只能使用一次 |
| `POST /app/preview/heartbeat` | `appId` | 主站展示预览期间每 30 秒调用一次，把预览授权延长 15 分钟 |

- 前端用隐藏的授权 frame 向 `<url>/__platform/access` 提交 `POST` 表单 `ticket=<ticket>`，票据不能出现在 iframe URL 中。校验通过后，预览来源签发 15 分钟有效的 `pm_preview` cookie（host-only、HttpOnly、SameSite=Lax）并返回 204。
- 页面、资源和 HMR WebSocket 都校验这个 cookie，过期返回 401。
- 前端每 5 分钟重新申请票据，通过授权 frame 刷新 cookie，不修改 iframe URL，不刷新正在展示的页面。

### 10.8 健康检查

- 两个接口都直接返回 JSON，不套统一包络。
- `GET /health`：`{ status, uptimeSeconds }`。
- `GET /health/ready`：检查 PostgreSQL、Redis 和运行时镜像，正常返回 200 和 `{ status, checks }`，任一不可用返回 503。
- `GET /v3/api-docs`：OpenAPI 文档。

### 10.9 前端接入

- 前端使用 `ai@6.0.330` 的 `DefaultChatTransport` 发送请求并解析 chunk，用 `readUIMessageStream` 维护实时 `UIMessage`；`src/api/generated/` 中的 `ChatUIMessage`（由 `openapi.json` 生成）与 10.4、10.5 保持一致，手写的流式代码在 `src/api/streamChat.ts`。
- 断流时不自动重发，而是用 `runId` 或 `clientRequestId` 查询终态；状态未确认时不显示成功或已取消。
- 生成期间预览 iframe 保持挂载，让 HMR 和自动刷新持续生效。
- 生成中发送新要求时，先取消旧运行，等它进入终态、旧流和历史收尾完成后，再用新的 `clientRequestId` 发起请求；取消失败或状态未确认时保留输入，不启动重叠的运行。

## 11. 范围边界

**包含**：注册登录、应用管理、对话历史、文件和技能工具、受控依赖、实时预览、验证修复、取消、限流和持久化。

**不包含**：多实例与跨机调度、SSR、生成应用的后端或数据库、版本回滚、部署分享、源码下载、精选、管理后台、封面截图、可视化编辑、自动上下文摘要、中断续跑。这些功能在界面上不提供入口，也不调用相应 API。

## 12. 决策记录

| ADR | 决策 |
|---|---|
| [0001](adr/0001-ai-sdk-with-plain-ts-orchestration.md) | Agent 使用 AI SDK 和普通 TS 编排，只用 Responses 接口 |
| [0002](adr/0002-docker-isolation-via-cli.md) | 生成的代码只在 Docker 容器中运行，后端通过 Docker CLI 调度 |
| [0003](adr/0003-per-app-preview-origin.md) | 每个应用使用独立的预览来源，经网关鉴权 |
| [0004](adr/0004-concurrency-limits-in-postgres.md) | 并发约束放在 PostgreSQL，Redis 不可用时拒绝 |
| [0005](adr/0005-single-instance-no-resume.md) | 单实例部署，重启不续跑 |
| [0006](adr/0006-code-gen-type-is-a-label.md) | 生成类型只作展示标签 |
| [0007](adr/0007-dependency-allowlist-and-registry-relay.md) | 依赖白名单与 registry 中继 |
| [0008](adr/0008-no-automatic-context-summarization.md) | 上下文超限时失败，不自动摘要 |
| [0009](adr/0009-separate-ui-messages-from-session-entries.md) | 消息与会话记录分开存放 |
