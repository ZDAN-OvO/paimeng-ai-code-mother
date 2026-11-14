# 派蒙独立 TS 后端实施计划

## 1. 目标、范围与当前事实

保留 Vue 主站，以独立 NestJS 后端和 Vercel AI SDK 重写 Agent。首版交付：登录 → 创建应用 → 真实生成文件 → 实时预览 → 连续修改及切换项目形式 → 验证修复 → 停止后继续。

本次仅完成规划，不修改文件、不安装依赖、不启动基础设施、不执行迁移或提交代码。

已核查的仓库事实：

- 当前分支为 `refactor/ts-backend`，工作区干净；Java 单体和微服务已经归档，后续不再迁移旧代码或旧数据。
- 尚无新 TS 后端。前端使用 Vue 3、Vite 7、TypeScript，现有包锁为 `package-lock.json`。
- [AppChatPage.vue](/home/zdan/github/zdan/paimeng-ai-code-mother/paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue:478) 使用 GET EventSource，部分断流被当作成功；生成期间还会隐藏 iframe，需要一起调整。
- [env.ts](/home/zdan/github/zdan/paimeng-ai-code-mother/paimeng-ai-code-mother-frontend/src/config/env.ts:21) 根据类型拼预览路径，需要改成后端提供预览入口。
- 旧可视化编辑器直接访问 iframe 文档。用户已决定首版延后，隐藏编辑模式和元素选择入口。
- 聊天 Markdown 当前允许原始 HTML，实施时关闭，避免生成内容通过聊天区影响主站。
- 当前 Node 为 26.13.0。pnpm、Docker 的版本和运行状态因 Plan 策略限制尚未验证，列为实施前置检查，不能算作已通过。

**首版包含**：注册登录、session、应用创建/列表/详情/改名/删除、结构化聊天历史、文件及 skill 工具、受控依赖、实时预览、构建修复、取消、限流和持久化。

**首版不包含**：SSR、业务后端、生成应用的数据库服务、微服务迁移、旧数据导入、版本/回滚、部署分享、源码下载、精选、管理后台、封面截图、可视化编辑、自动上下文摘要、中断续跑、多实例调度。未实现的入口隐藏，并停止相应 API 调用。

## 2. 工程与部署结构

### 技术基线

- 新后端目录：`paimeng-ai-code-mother-backend/`；现有 Vue 前端保留。
- 根 pnpm workspace 只纳入前端和新后端，不纳入 `deprecated/` 或 `local/`。统一锁文件，完成依赖核对后替换前端旧 npm 锁文件。
- NestJS 使用 Express adapter；数据库使用 Drizzle 的 `pg` 驱动；流程使用普通 TS 编排。
- Agent 使用 `ai` 和 `@ai-sdk/openai`，显式调用 Responses 模型接口，不切换成 Chat Completions，不引入 LangChain、LangGraph 或 Workflow。
- Redis 使用 node-redis；登录使用 express-session、connect-redis；校验使用 zod、nestjs-zod；搜索使用 `@vscode/ripgrep`。
- 后端模块按 Config、Auth、Apps、Conversations、Runs、Agent、Tools、Skills、Runtime、Preview 分工。控制器不承载工具循环或 Docker 调度逻辑。
- 补齐必要的驱动、Nest/OpenAPI、代理和测试配套包。生产依赖及容器镜像在实施第一阶段解析兼容的稳定版本并锁定，不使用浮动 `latest`。目标环境为 Node 24 LTS、pnpm 10、NestJS 11、AI SDK 6/OpenAI provider 3；主站 Vue/Vite 不进行无关升级。

### 单机部署默认值

首版支持 Linux + Docker Engine，NestJS 在宿主机运行，方便直接访问 `http://127.0.0.1:3425/v1`。Compose 管理 PostgreSQL 16、Redis 7 和 Nginx；后端使用固定参数的 Docker CLI 管理应用环境，不把 Docker socket 提供给生成应用。

- 后端监听 `127.0.0.1:8123`，统一 `/api` 前缀。
- PostgreSQL、Redis 默认只映射宿主机回环地址，端口分别为 5433、6380。
- 本地主站默认 `http://paimeng.localhost:8080`。
- 应用预览默认 `http://app-{appId}.preview.paimeng.localhost:8080`，每应用独立来源。
- Nginx 在 Linux 使用 host network，主站转发至 Vue 开发服务或静态产物；预览统一转发至 NestJS 的预览网关。应用容器不发布宿主机端口。
- PostgreSQL、Redis、源码和平台管理的依赖数据持久化；容器可重建。源码位于新后端 `runtime/output_code/{appId}/`。
- `.env`、运行目录、日志、依赖数据和截图测试产物加入忽略规则。保留 `deprecated/`、`local/`，不顺带清理历史目录。

README 维护启动说明；`docs/api.md` 维护当前产品/API 契约。实施不再扩写多份平行设计文档。

## 3. 数据模型、状态与一致性

### 数据表

| 表 | 关键字段与约束 |
|---|---|
| users | 数值 ID、唯一账号、密码哈希、展示信息、时间；不保存明文密码 |
| apps | 数值 ID、owner_id、名称、init_prompt、只读 code_gen_type、active/deleting 状态、执行阻塞标记、删除错误及重试信息 |
| conversations | ID、app_id 唯一、创建时间 |
| messages | ID、conversation_id、run_id、role、status、content JSONB、创建/更新时间 |
| agent_runs | UUID、app_id、conversation_id、client_request_id、状态、阶段、步数、修复次数、开始/截止/结束时间、错误码和错误摘要 |
| agent_session_entries | conversation_id、run_id、单调序号、记录类型、payload JSONB、时间；序号唯一 |

用户和应用保持数值 ID，兼容现有前端；run/request 使用 UUID，时间统一为 UTC ISO 字符串。首版不创建 checkpoint 表。

`messages.content` 使用 Vercel AI SDK 的 `UIMessage`。助手 parts 按实际发生顺序保存文本、dynamic-tool、计划修订和验证状态；工具完成只更新原位置。完整模型调用参数和截断后的工具返回存执行记录，不混入聊天正文。折叠和展开状态只属于前端，不写入消息。

### 接收消息事务

1. 校验登录、所有者、应用状态、请求体和限流。
2. 锁定用户及应用记录；检查用户正在运行的应用数和当前应用单 run 约束。
3. 在同一事务写用户消息、`running` run、`streaming` assistant 占位和本轮输入执行记录。
4. 提交后发送 SSE 开始事件，再调用模型。

用数据库部分唯一索引保证同一应用只有一个 `running/cancelling` run；用户行锁保证同时发往不同应用的请求不能绕过 5 个并发上限。Redis 负责按应用的滑动窗口限流；依赖不可用时拒绝新运行，不降级为进程内计数。

`clientRequestId` 在应用内唯一：重复请求不产生第二条用户消息或第二个 run，返回已有 run 标识；同 ID 不同内容返回冲突。它用于防重，不提供执行恢复。

### 状态机与结束规则

- run：`running → completed / failed`，或 `running → cancelling → cancelled`。
- 阶段：准备、生成、安装、验证、修复、收尾；阶段不重置预算。
- assistant：`streaming → completed / failed / cancelled`。
- 结束通过一个统一 finalizer，以条件更新保证只发生一次；终态不会被后来的断连或工具回调覆盖。
- 主动取消在终态提交前被接受时，禁止继续完成后续验证或文件任务；已完成的文件写入如实记录，不声称撤销。
- 终态事务提交后才发送最终 SSE 事件；正常关闭 SSE 不再次触发取消。

模型文本按短时间/大小批量保存，工具调用在产生副作用前保存。工具执行按应用串行，成功、失败和取消都有对应结果。取消时刷新文本缓冲，补齐已确认调用但尚无结果的工具记录。

启动时先取得单实例锁，拒绝第二个后端实例；将遗留 `running/cancelling` run 及其 assistant 收尾为失败，补齐中断结果，核对并停止带本项目标签的遗留容器，然后才接受新运行。不会自动继续调用模型。

## 4. API、SSE 与前端适配

### API 契约

普通接口继续返回 `{ code, message, data }`，成功码为 0，未登录保留 40100；同时使用对应 HTTP 状态。前端统一处理 HTTP 401，修正原先只检查成功响应体的逻辑。

| 接口 | 行为 |
|---|---|
| POST `/api/user/register`、`/login`、`/logout`；GET `/api/user/get/login` | 保留现有账号字段和 cookie session |
| POST `/api/app/add` | 只创建应用及对话，不调用类型路由模型，不自动启动后台 run；名称沿用初始提示词前 12 个字符 |
| POST `/api/app/my/list/page/vo` | 保留分页结构；排序字段使用允许列表 |
| GET `/api/app/get/vo?id=…` | 返回应用信息、当前 run、检测类型和预览状态；仅所有者可读 |
| POST `/api/app/update` | 仅所有者改名，长度 1–50 |
| POST `/api/app/delete` | 进入删除流程；运行中返回冲突 |
| GET `/api/chatHistory/app/{appId}` | 保留路径，返回结构化消息、状态和不透明游标；游标含稳定 ID，避免相同时间漏消息 |
| POST `/api/app/chat/gen/code` | JSON `{appId,message,clientRequestId}`，返回 SSE；消息长度沿用前端的 1–1000 字符 |
| GET `/api/app/run/status` | 按 appId 和 runId 或 clientRequestId 查询，支持断流后的状态确认 |
| POST `/api/app/run/cancel` | 按 appId、runId 幂等取消；只允许所有者 |
| POST `/api/app/preview/start`；GET `/api/app/preview/status` | 启动/查询环境，不启动 Agent |
| POST `/api/app/preview/access` | 签发短期预览授权票据 |
| POST `/api/app/preview/heartbeat` | 更新可见预览的访问租约 |
| GET `/api/health`、`/api/health/ready`、`/api/v3/api-docs` | 存活、依赖就绪和 OpenAPI |

账号沿用至少 4 字符、密码至少 8 字符及重复密码校验；新密码使用 Node scrypt 加随机盐。登录更换 session ID，退出销毁 session。默认 session 有效期 7 天；cookie 为 host-only、HttpOnly、SameSite=Lax，HTTPS 环境启用 Secure。修改请求验证主站 Origin，防止预览借助浏览器发送跨来源写操作。

### UI Message Stream

聊天响应使用 AI SDK UI Message Stream。`text-*`、`tool-*`、`data-plan`、`data-validation` 形成持久化消息；运行开始、阶段、模型进度、预览和终态使用 transient `data-*`，其中 `data-run` 必须包含 `completed/cancelled/failed` 与可展示原因。

- 前端使用精确版本 `ai@6.0.330` 的 `DefaultChatTransport` 解析 chunk，使用 `readUIMessageStream` 维护实时消息状态。
- 每 15 秒发送注释心跳；Nginx 关闭缓冲与缓存，不使用 Axios 的普通 60 秒请求超时管理流。
- 不发送 reasoning，不将执行记录原样推给 UI。
- 只有明确 `completed` 才显示成功；失败和取消保留文本及工具摘要。
- 断流不自动重发请求，按 requestId/runId 查询终态；离线时显示状态待确认，不自行宣称成功或取消。
- 离开路由或卸载组件时 AbortController 关闭流；后端以响应连接异常关闭判断取消，不把请求体读取完成误当断连。

前端保留当前布局和主要路由。移除按类型拼 URL、按消息条数猜预览就绪、完成后固定延迟刷新等逻辑。生成期间保持 iframe 挂载，展示独立状态条，让 HMR 持续工作。首页精选及下载/部署/管理/可视化编辑入口不再发请求；应用卡片进入自己的聊天或实时预览。

## 5. Agent、工具、依赖与上下文

### Agent 编排

使用同一个主 Agent 的消息历史。AI SDK 负责流式模型调用和工具循环；NestJS 负责外层生成 → 验证 → 失败修复流程。工具执行包装层负责授权、持久化、预算与取消，不能直接把文件函数裸露给模型。

网关固定使用 `http://127.0.0.1:3425/v1`、模型 `auto/deepseek-v4.1-flash`，显式 Responses API。关闭 SDK 隐式重试；模型请求默认超时 120 秒，所有修复调用共享 run 的步数和总截止时间。

Agent 在每次生成阶段结束后进入后端验证；失败追加结构化错误到同一会话，再进入下一修复阶段。首次验证加最多 3 次修复，共最多 4 次验证尝试；构建、静态检查和启动错误共用修复预算。验证通过前不向 UI 宣告运行成功。

### 工具契约

- 文件工具：`read/write/edit/grep/find/ls/delete`。仅能访问当前应用；拒绝绝对路径、`..`、软链接、特殊文件和越界路径。
- `read` 默认最多 2000 行/50 KiB；grep 最多 100 条，find 1000 条，ls 500 条，并返回截断与续读信息。
- 写文件使用同目录临时文件加原子替换。edit 要求每个 oldText 唯一匹配；写入/编辑/删除已有文件检查读取版本。目录删除要求先列出目录并核对版本，显式递归，不允许删除应用根目录。
- 文件写入和工具任务按应用串行；每次落盘前重新检查 run 的取消信号。
- 平台保留锁文件、包源配置、pnpm hook/workspace 配置、node_modules、dist 和运行缓存，通用工具不能修改。
- 初始默认上限：单文件 1 MiB、源码总量 100 MiB、文件数 5000；超出返回明确工具错误。源码、依赖、日志的统计分别计算。
- `load_skill({name})` 只读注册的 SKILL.md；`read_skill_resource({name,path,offset,limit})` 读取该 skill 内资源。通用文件工具不访问 skill。
- `dependencies` 工具提供 list_allowed、list_installed、add、remove、sync；`preview` 工具只提供 status、logs。

### 技能注册契约

- 技能位于后端根目录 `.paimeng/skills/<name>/SKILL.md`；目录名必须与 frontmatter `name` 一致。
- 采用 Codex skill 格式：YAML frontmatter 必填 `name`、`description`，可选 `license`、`allowed-tools`、`metadata`；名称使用小写连字符，描述不超过 1024 字符。
- `load_skill({name})` 返回去掉 frontmatter 的 Markdown 正文；元数据用于注册、系统提示和技能选择。
- `read_skill_resource({name,path,offset,limit})` 只读取该技能 `references/`、`scripts/`、`assets/` 下的文本资源，拒绝绝对路径、`..` 和软链接越界。

### 依赖与运行代码的边界

初始允许的直接依赖严格采用已确认的 16 个包：vite、typescript、vue、@vitejs/plugin-vue、vue-tsc、vue-router、pinia、react、react-dom、@vitejs/plugin-react、@types/react、@types/react-dom、tailwindcss、@tailwindcss/vite、lucide-vue-next、lucide-react。

实施时验证并锁定兼容版本范围。每次安装均检查整份声明，覆盖 dependencies、devDependencies、optionalDependencies 和 peerDependencies，拒绝通过其他声明绕过。禁止 Git、tarball、本地、别名及 workspace 来源；间接依赖同样必须来自指定 registry。锁文件只能由平台生成。

安装任务只得到经过过滤的 manifest 和平台配置，不挂载应用源码或项目 hook；默认禁止安装脚本，必要脚本按包和版本逐项允许。安装成功后整体切换依赖版本，失败不把半成品挂给开发服务器。

开发和构建容器不获得互联网出口，不能通过 package 脚本自行下载另一个依赖。安装容器通过受限的 registry 中继访问 npm；该中继只转发 npm 元数据和包文件，无其他后端权限。它使用独立监听/网络，不能借此访问主站、数据库或其他应用。允许列表管理依赖选择，不声称已经审计全部间接代码。

### 上下文

执行记录按顺序还原为 SDK 模型消息，正确组合 assistant 工具调用与 tool result；内部状态事件不会被误当用户消息。reasoning 及其专用内容不入库。

工具输出产生时截断到最多 50 KiB，保留错误、尾部日志和截断标记；持久化与后续上下文使用同一结果。不会先保存无限返回再临时截断。

`AI_CONTEXT_WINDOW_TOKENS` 为必须明确配置的模型容量；输出默认预留 8192 tokens，并保留协议安全余量。容量不能确认时不猜测模型支持更大上下文。首版使用包含系统提示、工具 schema 和历史内容的保守 UTF-8 字节上界估算，实际网关超限也明确失败。超限后不自动摘要或删除旧历史；当前应用将保持无法继续模型运行，直到后续引入显式上下文管理，或用户新建应用。

## 6. 应用环境、预览与清理

### 容器生命周期

一个应用复用一个预览环境；安装和构建使用属于该应用的短生命周期任务容器。它们共用应用归属和预算，不增加可由 Agent 任意控制的后台任务能力。

- 应用源码在执行容器内只读挂载，只有后端文件工具能改动源码。依赖只读挂载；dist、临时目录和缓存使用单独可写位置。
- 容器使用非 root 用户、只读根文件系统、去除 capabilities、no-new-privileges、默认 seccomp；无后端环境变量、session、模型 key、Docker socket或其他应用目录。
- 各应用网络隔离；预览与构建没有通往主站/数据库/其他应用的网络路径，只有受控网关可以访问预览端口。
- 默认预览容器 512 MiB/1 CPU，安装或构建任务 1536 MiB/1 CPU，每容器限制 128 个进程。整机应用环境预算默认最多 8 GiB，启动前还要求宿主机至少保留 2 GiB 可用内存及 2 GiB 可用磁盘；均可配置。
- 最多 5 个活跃预览环境，超出或资源不足时明确拒绝，不偷偷创建排队任务；每用户最多 5 个 running 应用的逻辑限制独立生效。
- 安装与构建临时文件、依赖池和日志设清理策略；日志每应用最多保留 10 MiB。磁盘水位不足时拒绝新任务，不能等磁盘写满后才失败。

停止 run 终止本轮任务容器，保留预览容器。若无法确认任务已停止，标记该应用执行阻塞，不允许开启新 run，直到清理核对通过。

可见预览每 30 秒发送访问心跳。没有 run，且最后一次可见访问超过 15 分钟，回收容器；后台 WebSocket 保活不算持续有人查看。定时清理周期 30 秒，回收容许 30 秒调度误差。

### 预览服务与鉴权

- 静态项目由平台提供服务器、刷新脚本和文件监听，不要求 package.json。完整文件写入后才触发刷新。
- 首批构建项目基于允许的 Vite 组合，提供 dev/build 脚本及平台约定的缓存、输出路径。端口固定为容器内部 3000，监听 0.0.0.0，严格端口，Host/HMR 地址由平台配置。
- 启动配置或依赖变化时重启服务；普通源码由 HMR/自动刷新处理。
- Nginx 转发 HTTP/WS 至 NestJS 预览网关；网关按应用查找目标，不接受用户提交任意上游地址。选用 http-proxy-middleware 处理流与升级连接。
- 主站签发 60 秒有效、单次使用、绑定用户/app/session 的授权票据；通过 POST 建立该预览来源的 host-only、HttpOnly cookie，避免票据出现在资源 URL 或访问日志。
- 预览授权默认有效 15 分钟；主站查看期间每 5 分钟通过隐藏授权 frame 更新，不能刷新正在展示的页面。新窗口授权过期后引导回主站重新建立权限。
- 每个页面、资源请求和 WS 握手都检查当前 owner、主 session、应用删除状态和预览授权。授权 cookie 不转发给容器；容器响应不能覆盖平台 cookie 或隔离头。
- 网关登记 WS 连接，退出登录、应用删除及授权过期时关闭关联连接，而非只检查首次握手。
- iframe 使用 allow-scripts、allow-same-origin、allow-forms，预览来源与主站不同，不开放顶层导航。预览响应使用相应 sandbox/CSP，禁用 service worker 绕过鉴权；主站拒绝来自预览来源的写操作。

`codeGenType` 由文件/依赖检测得到，初始为 null，可展示 static、vue、react 或其他受支持前端；它只用于标签和筛选。是否构建独立根据实际 manifest 和脚本判断，不根据标签选择执行逻辑。

### 删除

在同一应用锁内检查没有运行中 run，然后持久化 deleting 状态。立即禁止预览和发消息，撤销授权并关闭 WS，再停止容器、删除专属依赖/缓存/源码，最后事务删除对话和执行记录。

保留删除任务的必要元数据直到全部清理成功；失败按 5 秒、30 秒、2 分钟、之后每 10 分钟重试，重启后继续。普通列表不展示 deleting 应用，删除失败状态可查询。只清理带当前项目/app 标签的资源，不使用无范围的 Docker prune，不触碰共享或其他项目数据。

## 7. 分阶段实施与进入下一阶段的闸门

| 阶段 | 实施内容 | 通过后才能继续的证据 |
|---|---|---|
| 0：环境与协议探针 | 核对 pnpm/Docker/Compose、版本、端口、网关、容量配置和 Responses 流协议；锁定依赖 | 最小真实 Responses 调用、一次工具调用及其结果回传均成功；Docker 和 Compose 可用；失败只报告阻塞，不改用其他协议或宿主机执行 |
| 1：工程、数据与身份 | Nest 基础、迁移、session、应用 CRUD、所有者校验、文档契约 | 空库迁移及重复启动通过；注册登录退出、越权、分页、删除状态和唯一约束测试通过 |
| 2：文件、skill 与运行环境 | 文件 CAS、依赖策略、静态/Vite 服务、代理鉴权、资源回收 | 使用受控项目，在真实容器和浏览器中通过静态刷新、Vue HMR、隔离、退出撤权、超时终止和回收测试 |
| 3：Agent 与持久化 | AI SDK 循环、记录保存、上下文、验证修复、取消与启动收尾 | 本地脚本化 Responses 服务经过真实 SDK，完整验证工具执行、失败修复、取消、断流、重启和预算耗尽；不绕过 SDK 用内部 mock 宣称成功 |
| 4：Vue 接入 | POST SSE、结构化历史、状态 UI、实时 iframe、停止、隐藏延后功能 | 经 Nginx 的浏览器端到端测试通过，刷新页面与重复请求不重复生成，生成中 iframe 保持工作 |
| 5：真实模型验收 | 使用指定网关和模型完成连续真实生成 | 四轮固定场景、构建日志、执行记录和浏览器结果齐全，必选验收全部通过 |

每阶段失败先修根因，不把未通过阶段隐藏在后续 UI 工作中。测试仅重跑受修改影响的范围；最终再执行一次完整必选检查。

## 8. 必选验收标准

### 自动化与受控协议测试

1. **事务和并发**：同应用并发发送 20 个不同请求，只接受一个 run/一组消息；一个用户对 6 个应用同时申请，在资源充足的测试配置下最多接受 5 个。第 11 条有效发送触发应用分钟限流，其他应用不受影响。
2. **防重**：相同 clientRequestId 重复发送不产生第二个 run，首次 SSE 事件丢失后仍能查询到原 run。
3. **工具边界**：路径穿越、软链接、其他应用、skill 写入、平台文件修改、未读覆盖、唯一匹配失败均被拒绝且无文件副作用；输出和文件配额的边界值有测试。
4. **依赖策略**：允许包能安装；禁止包、超范围版本、直接编辑 manifest、Git/tarball/local/别名来源、项目 hook 和脚本绕过均失败；失败安装不破坏已安装依赖。
5. **实时预览**：静态多文件刷新和 Vue HMR 经真实 Nginx 工作；受控小项目在完整源码落盘后 3 秒内可见更新。冷启动遵守 60 秒上限，界面持续显示启动状态。
6. **取消**：模型流、文件工具、安装、构建、启动五种阶段分别测试主动停止与断流；正常条件下 5 秒内停止产生新工具副作用并收尾。已写文件保留，下轮能读取；无法停止的任务导致应用阻塞，绝不与新 run 重叠。
7. **竞争与重启**：完成/取消同时发生只产生一个终态；进程被杀后，重启不继续模型调用，无永久 streaming 消息、无悬空调用，无旧容器继续写入。
8. **上下文与预算**：模型步骤在所有修复阶段累计；第 100 步及 30 分钟边界后不再请求模型。安装 5 分钟、构建 3 分钟、启动 60 秒的超时测试使用可控时钟和可终止任务，不实际空等。输入预算不足时不发送模型请求、不删历史。
9. **权限**：用户 B 和未登录用户不能访问用户 A 的应用、消息、页面、JS/CSS 或 WS；无法绕过网关访问容器；退出和删除会关闭既有 WS。主站 cookie 不进入容器，预览不能读取或导航主站。
10. **删除和回收**：运行中拒删；故意制造部分清理失败，重启后仍能完成清理；15 分钟空闲回收和再访问重建通过，可见预览不会误回收。
11. **前端协议**：中文和 JSON 跨分片、明确终态、断流、403/409/429、工具摘要及历史重载通过；生成期间 iframe 不被卸载；不存在仍可点击的延期功能入口。
12. **代码检查**：前后端类型检查、无自动修复的 lint、构建、单元/集成/容器/浏览器测试通过。未安装 Docker 时相关测试必须报告阻塞，不能静默 skip 后显示全绿。

首版的运行时不做浏览器自动交互验收；上述浏览器检查属于开发交付测试，不会在用户每次生成时自动执行。

### 指定真实模型验收

使用真实注册用户、新建应用，以及指定网关和 Responses 协议，执行四轮固定任务：

1. 生成包含 HTML/CSS/JS 的页面，预览显示要求的标题和可工作的按钮。
2. 修改文字及按钮行为，验证确实修改已有文件、使用历史上下文，实时预览生效。
3. 在同一 app 切换到 Vue，依赖由工具安装，HMR 和生产构建通过。
4. 切回静态多文件，清理不再需要的 manifest/构建结构，静态自动刷新恢复。

每轮必须有 completed run、终态 assistant、可重建的执行记录、实际磁盘文件、验证日志和浏览器结果；不以模型自述或一张截图代替。真实 smoke 总预算默认 60 分钟，超时即记录验收未通过，不循环重跑直至偶然成功。真实页面按要求的内容和交互验收，不设未定义的审美评分。

## 9. 停止条件与最终交付

### 单次 run 的停止条件

| 触发 | 处理 |
|---|---|
| 静态检查/生产构建和预览探测全部通过 | completed，保存记录，预览继续 |
| 用户停止或异常断流 | cancelled，取消任务并补齐记录，预览继续 |
| 首次失败后 3 次修复仍未通过 | failed，展示最后错误及已用修复次数 |
| 100 模型步骤或 30 分钟总时长耗尽 | failed，终止当前工作，不重置预算 |
| 上下文超限、模型鉴权/协议错误、执行记录无法可靠落库 | failed，保留已有文件，不继续产生新工具副作用 |
| 单项任务超时或资源不足 | 返回结构化错误，在剩余修复及总预算内处理；无法恢复则 failed |
| 任务进程无法确认停止 | failed/收尾错误并封锁应用新运行，等待清理，不声称已安全释放 |

### 实施阶段必须暂停的条件

- Docker、网关、registry、数据库等外部依赖在最多两次有针对性的连通检查后仍不可用；记录原始错误和所需外部动作，不反复盲试。
- 指定网关不支持所需 Responses 工具往返、模型容量无法配置，或 SDK 无法满足已定持久化/取消契约。不得静默换模型、换协议或改框架。
- 无法满足容器隔离、权限检查、取消收尾或记录一致性。不得回退宿主机执行、公开容器端口或关闭鉴权。
- 实现必须扩展到已排除的产品功能，或需要破坏现有用户工作区/外部系统配置，先报告具体差异；不能借实现细节扩大范围。

普通代码错误和测试失败继续定位修复，不直接作为结束整个任务的理由。外部阻塞时标明“未完成/未验收”和影响阶段。

### 可以停止开发并交付的条件

全部必选检查通过，指定真实模型四轮验收通过，启动/配置/API 说明与最终实现一致，git diff 无密钥或运行产物，延期入口已处理，且没有阻塞首版使用的已知缺陷。

最终交付提供：改动摘要、启动步骤、配置项、实际检查结果、真实验收的 run 标识及产物证据、剩余限制。达到该标准后停止追加功能和视觉优化；不把版本、管理后台等延期功能顺带纳入。不自动推送远端。

**本计划提交后仍不执行。只有用户明确要求实施，且 Plan 模式退出后，才开始上述阶段。**
