# Paimeng 架构

## 架构约束

- 生成的代码不可信。它不能接触宿主机、主站、数据库、密钥、其他应用或互联网。
- 一次运行的结果只能以平台验证为准，不以模型自述为准。
- 任何终态只写入一次；重启、断连、取消和完成竞争时不能出现两个结果或永久“进行中”。
- 用户发送的消息可以进入应用内串行队列；运行资源、并发和限流约束不能被队列绕过，依赖不可用时暂停派发并明确报告，不能降级为不安全的实现。

**部署前提**：单台 Linux 主机，Docker Engine，单个后端实例，一个 OpenAI Responses 兼容的模型网关。

生成应用的安装、检查、构建和开发服务器在隔离容器中执行；静态页面由预览网关提供文件，在浏览器独立来源中执行。后端不执行生成的 JavaScript。

## 系统上下文

```text
浏览器
├── 主站来源      http://paimeng.localhost:8080
│   └── Nginx ─► Vue 主站
│            └─ /api ─► NestJS 后端（127.0.0.1:8123）
└── 预览来源      http://app-{appId}.preview.paimeng.localhost:8080
    └── Nginx ─► NestJS 预览网关 ─► 该应用的预览环境

NestJS 后端（宿主机进程，唯一能调用 Docker 的组件）
├── PostgreSQL 16   权威状态：用户、应用、对话、运行、运行详情
├── Redis 7         session、消息队列与 steer、应用限流、单实例锁、维护锁
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
| Redis | session、应用消息队列、运行中的 steer 收件箱、限流与锁等短生命周期共享状态 | 已开始运行、消息和会话记录的权威存储 |
| 容器 | 安装、检查、构建、运行生成的代码 | 访问平台的任何资源 |

## 后端模块架构

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
- **`runtime`** 封装文件工具校验和 Docker 执行；所有 Docker 命令带固定参数、超时和本项目标签。预览网关可以读取静态源码，运行详情服务可以读取源码快照；这些读取不执行生成代码。
- **`preview`** 拥有预览授权与网关，按应用 ID 查找上游。
- **`startup`** 在接受请求前完成单实例锁、遗留运行收尾和遗留容器核对。

当前存在的反向引用：`agent`、`tools` 和 `conversations` 引用 `runs` 下的运行详情服务或类型；`apps` 与 `preview` 互相引用。新代码不要再增加跨层反向依赖；需要时把共享部分下沉到独立模块。

当前 NestJS 注册方式是 `AppModule` 集中注册业务 controller/provider，仅 `config`、`db`、`redis` 为独立基础设施模块。上图描述职责分层，不代表已经完成 feature module 拆分。入口见[后端模块注册](paimeng-ai-code-mother-backend/src/app.module.ts)。

## 前端模块架构

[路由](paimeng-ai-code-mother-frontend/src/router/index.ts)连接首页、注册登录、应用对话和应用改名页面。`AppChatPage.vue` 组织消息输入、运行详情和预览；`utils/queuedChatCoordinator.ts` 协调队列恢复与订阅，`api/streamChat.ts` 处理流式协议。普通接口经过生成客户端与唯一的 `request.ts` 实例，登录状态由 Pinia 保存。

主站负责呈现平台返回的状态；运行结果、资源所有权和执行权限由后端决定。

## 领域模型与数据所有权

```text
用户 1 ─ n 应用
应用 1 ─ 1 对话 1 ─ n 消息
应用 1 ─ n 运行（同一时刻最多 1 个进行中）
运行 1 ─ 2 消息（用户、助手；已消费 steer 嵌入助手 parts）
运行 1 ─ n 会话记录
运行 1 ─ 1 计划、n 活动、n 变更文件、n 验证日志
```

| 数据 | 读者 | 存放 |
|---|---|---|
| 消息（`UIMessage`） | 用户 | `messages` |
| 会话记录：完整模型输入、工具调用、结果与已消费 steer | 模型（重建上下文）、审计 | `agent_session_entries` |
| 运行详情：计划、活动、变更、验证日志 | 用户 | `run_*`、`content_blobs` |
| 应用消息队列：尚未开始的普通消息、未生效或已退回的 steer | 用户、队列调度器 | Redis，按应用隔离 |
| 源码、依赖、构建产物、任务日志 | 容器、文件工具 | 后端 `runtime/` 下按应用分目录 |

消息与会话记录分开存放，见 [ADR-0009](docs/adr/0009-separate-ui-messages-from-session-entries.md)。队列状态以 Redis CAS 原子更新，见 [ADR-0011](docs/adr/0011-redis-message-queues.md)；队列中的普通消息和未生效 steer 不写入 PostgreSQL，只有普通消息成为运行或 steer 被 Agent 消费时才创建对应数据库记录。所有资源都归属于某个应用，所有查询都校验应用的所有者。

持久化字段与索引见[数据库 schema](paimeng-ai-code-mother-backend/src/db/schema.ts)；字段级 API 类型由后端 zod schema 导出，产物见[openapi.json](paimeng-ai-code-mother-backend/openapi.json)。

## 信任边界

```text
信任   ┌ 后端进程、PostgreSQL、Redis、技能文件
       │
半信任 ├ 已登录用户：只能操作自己的应用
       │
不信任 ├ 模型输出：只能通过工具操作当前应用目录
       ├ 生成的代码：服务端执行限于容器，页面在预览来源执行
       └ 预览页面：独立来源，不能读写主站
```

| 边界 | 实现 | 决策 |
|---|---|---|
| 主站身份、session、Origin 与公开接口 | `src/auth/` | — |
| 模型能力、计划与技能只读 | `src/agent/`、`src/tools/`、`src/skills/` | [ADR-0001](docs/adr/0001-ai-sdk-with-plain-ts-orchestration.md)、[ADR-0008](docs/adr/0008-no-automatic-context-summarization.md) |
| 文件、依赖、容器、网络和资源配额 | `src/runtime/` | [ADR-0002](docs/adr/0002-docker-isolation-via-cli.md)、[ADR-0007](docs/adr/0007-dependency-allowlist-and-registry-relay.md) |
| 独立来源、票据、cookie 与代理 | `src/preview/` | [ADR-0003](docs/adr/0003-per-app-preview-origin.md) |
| 终态、幂等、并发、取消与重启 | `src/runs/`、`src/startup/` | [ADR-0004](docs/adr/0004-concurrency-limits-in-postgres.md)、[ADR-0005](docs/adr/0005-single-instance-no-resume.md)、[ADR-0011](docs/adr/0011-redis-message-queues.md) |
| 所有者与资源删除 | `src/apps/` | — |
