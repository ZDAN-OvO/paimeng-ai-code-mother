# 派蒙 AI 应用工坊 API 契约

本文是前后端唯一的接口契约。除健康检查与预览入口外，所有接口都要求已登录（`pm_sid` session cookie）。

## 通用约定

- 前缀：`/api`
- 请求/响应：JSON；成功响应包络 `{ "code": 0, "message": "ok", "data": ... }`
- 失败响应包络 `{ "code": <错误码>, "message": "<中文原因>", "data": null }`，并同时返回对应 HTTP 状态码。
- 用户、应用使用数值 ID；运行使用 UUID；时间为 UTC ISO 8601 字符串。
- 修改类请求必须携带主站 `Origin`；不在 `ALLOWED_ORIGINS` 内返回 403。

### 错误码

| code  | HTTP | 含义 |
| ----- | ---- | ---- |
| 0     | 200  | 成功 |
| 40000 | 400  | 参数或状态不允许 |
| 40100 | 401  | 未登录或登录已失效 |
| 40300 | 403  | 无权访问该资源 |
| 40400 | 404  | 资源不存在 |
| 40900 | 409  | 冲突（运行中删除、重复请求内容不一致） |
| 42900 | 429  | 限流 |
| 50000 | 500  | 服务内部错误 |
| 50300 | 503  | 依赖不可用（Redis、Docker 等） |

## 身份

### POST /api/user/register

```json
{ "userAccount": "tester1", "userPassword": "password123", "checkPassword": "password123" }
```

账号 4–64 字符，密码 8–128 字符且两次一致。成功后直接登录，返回 `LoginUserVO`。

### POST /api/user/login

```json
{ "userAccount": "tester1", "userPassword": "password123" }
```

成功后重新生成 session ID，返回 `LoginUserVO`。

### POST /api/user/logout

销毁当前 session，返回 `true`。

### GET /api/user/get/login

返回当前 `LoginUserVO`：

```json
{
  "id": 1,
  "userAccount": "tester1",
  "userName": "tester1",
  "userAvatar": null,
  "userProfile": null,
  "userRole": "user",
  "createTime": "2026-11-12T08:00:00.000Z",
  "updateTime": "2026-11-12T08:00:00.000Z"
}
```

## 应用

### POST /api/app/add

```json
{ "initPrompt": "做一个待办事项页面" }
```

只创建应用与对话，不调用模型、不自动开始运行。应用名取提示词前 12 个字符。返回 `{ "id": 3 }`。

### POST /api/app/my/list/page/vo

请求体：`pageNum`（默认 1）、`pageSize`（默认 12，最大 50）、`sortField`（`createTime` | `updateTime` | `id` | `appName`）、`sortOrder`（`asc` | `desc`）。只返回 `active` 应用。`GET /api/app/my/list/page` 保留为兼容别名。

返回 `{ "records": AppVO[], "total": 1, "current": 1, "pageSize": 10 }`。

### GET /api/app/get/vo?id=3

仅所有者可访问。返回 `AppVO`，包含当前运行与预览状态：

```json
{
  "id": 3,
  "appName": "用 Vue 3 + Vite 创建",
  "initPrompt": "用 Vue 3 + Vite 创建一个待办事项应用",
  "codeGenType": "vue",
  "userId": 1,
  "status": "active",
  "createTime": "2026-11-12T08:00:00.000Z",
  "updateTime": "2026-11-12T08:01:00.000Z",
  "currentRun": {
    "runId": "abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
    "id": "abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
    "status": "running",
    "phase": "generate",
    "stepCount": 4,
    "repairCount": 0,
    "startedAt": "2026-11-12T08:16:37.982Z",
    "deadlineAt": "2026-11-12T08:46:37.970Z"
  },
  "preview": {
    "status": "running",
    "kind": "vue",
    "url": "http://app-3.preview.paimeng.localhost:8080",
    "lastError": null
  }
}
```

`codeGenType` 由源码与依赖检测得出，可能为 `null`、`static`、`vue`、`react`。`preview.status` 为 `stopped`、`starting`、`running`、`failed`。

### POST /api/app/update

```json
{ "id": 3, "appName": "我的待办" }
```

名称 1–50 字符，仅所有者可改。

### POST /api/app/delete

```json
{ "id": 3 }
```

仅所有者可删。存在 `running`/`cancelling` 运行时返回 409，需要先取消。确认后立即禁止消息与预览，清理容器、专属依赖、缓存与源码，并删除对话与执行记录。删除失败会按 5s / 30s / 2min / 之后每 10min 重试，重启后继续。

## 对话历史

### GET /api/chatHistory/app/:appId?cursor=<opaque>&pageSize=20

仅所有者可访问。`pageSize` 默认 20、最大 50。返回按时间正序的记录与不透明游标：

```json
{
  "records": [
    {
      "id": 7,
      "runId": "abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
      "role": "user",
      "status": "completed",
      "content": {
        "id": "user:abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
        "role": "user",
        "parts": [{ "type": "text", "text": "改成 Vue 版本", "state": "done" }]
      },
      "createTime": "2026-11-12T08:16:37.982Z",
      "updateTime": "2026-11-12T08:16:37.982Z"
    },
    {
      "id": 8,
      "runId": "abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
      "role": "assistant",
      "status": "completed",
      "content": {
        "id": "assistant:abd5fd94-17c4-4614-ac9e-1441f7ce4b5e",
        "role": "assistant",
        "parts": [
          { "type": "text", "text": "先检查项目。", "state": "done" },
          {
            "type": "dynamic-tool",
            "dynamic": true,
            "toolName": "read",
            "toolCallId": "call-1",
            "state": "output-available",
            "input": { "path": "index.html" },
            "output": {}
          },
          { "type": "text", "text": "已完成 Vue 版本。", "state": "done" },
          {
            "type": "data-plan",
            "id": "plan:1",
            "data": { "revision": 1, "steps": [{ "id": "1", "title": "实现", "status": "completed" }] }
          }
        ]
      },
      "createTime": "2026-11-12T08:16:38.982Z",
      "updateTime": "2026-11-12T08:16:39.982Z"
    }
  ],
  "nextCursor": "djE6Nw",
  "hasMore": false
}
```

`role` 为 `user` 或 `assistant`；`status` 为 `streaming`、`completed`、`failed`、`cancelled`。`nextCursor` 为 `null` 表示没有更多。

`content` 是 Vercel AI SDK 的 `UIMessage`。`parts` 的顺序就是消息实际发生顺序，只合并连续文本增量：

- `text`：用户或助手正文。
- `dynamic-tool`：工具名、调用 ID、状态和安全摘要输入/输出，不包含文件全文或完整工具输出。
- `data-plan`：计划修订快照。
- `data-validation`：一次验证检查的状态。

消息 ID 固定为 `user:{runId}` 和 `assistant:{runId}`。完整工具输入/输出与模型执行记录存放在服务端执行记录中。

## 运行与 SSE

### POST /api/app/chat/gen/code

```json
{ "appId": 3, "message": "把标题改成我的待办", "clientRequestId": "4d1e..." }
```

- `message` 长度 1–1000。
- `clientRequestId` 由前端生成，应用内唯一。重复请求不会产生第二条消息或运行，直接返回已有运行的 SSE；同一 ID 携带不同内容返回 409。
- 并发限制：每个应用同一时刻只有一个运行；每个用户最多 5 个应用同时运行；每个应用每分钟最多 10 次请求（429）。
- 响应为 Vercel AI SDK **UI Message Stream**，`Content-Type: text/event-stream`，每个 `data:` 是一个 `UIMessageChunk`：

```
data: {"type":"text-start","id":"text:1"}

data: {"type":"text-delta","id":"text:1","delta":"正在"}
```

持久化到消息的 chunk 为 `text-*`、`tool-input-available`、`tool-output-available`、`tool-output-error`、`data-plan`、`data-validation`。运行控制通过 transient chunk 传递，不写入消息：

| chunk | data |
| --- | --- |
| `data-run-started` | `{ runId, status }` |
| `data-model` | 模型进度计数，不含参数或推理原文 |
| `data-phase` | `{ runId, phase }` |
| `data-preview` | `{ status, kind, url?, error? }` |
| `data-run` | `{ runId, status, errorCode, errorSummary, stepCount, repairCount, detailsStatus, detailsError, changes }` |

每 15 秒发送注释心跳 `: ping`，结束时发送 `data: [DONE]`。不发送模型 reasoning。只有最后一条 `data-run.data.status === "completed"` 才表示成功。浏览器离开页面或连接异常关闭会触发取消；正常收到终态后的关闭不会重复取消。连接中断后可用运行 ID 查询终态。

`model-status` 区分等待响应与正在接收文件参数。流式进度每秒最多更新一次，工具切换会立即通知；仅请求开始、结束和失败摘要保存到运行活动，避免进度挤占历史记录配额。`inputBytes` 是本次响应累计接收的工具参数 UTF-8 字节数。输入和输出 token 数来自网关返回的 usage，网关未返回时字段缺省。前端只展示用户可理解的编写进度。

生成中可编辑并发送新要求。前端先取消旧运行，确认其终态并等待旧请求收尾，再使用新的 `clientRequestId` 发起下一轮；取消失败或状态未确认时保留输入，不启动重叠运行。

前端使用 `ai@6.0.330` 的 `DefaultChatTransport` 和 `readUIMessageStream`：前者负责请求与 chunk 解析，后者负责实时 `UIMessage` 状态。`src/api/typings.d.ts` 的 `ChatUIMessage` 与该契约保持一致。

### GET /api/app/run/status?runId=<uuid>

也可以使用 `GET /api/app/run/status?appId=3&clientRequestId=<id>` 在首次 SSE 事件丢失后确认原运行。

返回运行状态、阶段、步数、修复次数、错误码、时间以及 `detailsStatus`。终态包括 `completed`、`failed`、`cancelled`。`detailsStatus` 为 `pending`、`ready` 或 `incomplete`，不能用聊天文本推断详情是否完整。

平台只在本轮实际发生源码变更后执行安装、构建和预览验证。模型只读文件或只回复文字时不会进入验证；连续两次没有变更会以 `NO_CODE_PRODUCED` 结束。已有代码但验证失败后没有产生新的修复变更时，以 `VALIDATION_FAILED` 结束。

模型输出截断（`finishReason=length`）或 SDK 标记无效的工具调用不会作为有效完成进入验证。无效调用不执行文件操作；平台要求拆分模块和缩短单次参数，在没有成功文件变更期间累计 3 次异常后停止，只读调用不会重置计数。运行错误码为 `MODEL_OUTPUT_LIMIT`（输出上限）或 `MODEL_OUTPUT_INVALID`（无效调用）。SDK 流内错误直接成为 `MODEL_ERROR`，不再误判为“没有生成代码”，同时立即终止上游请求。取消或出错前已经输出的文字保留。这些是运行终态错误码，HTTP 包络错误码不变。

原始执行记录保留审计。重建模型上下文时，无效调用及其对应结果转换为简短失败说明，不再次回传截断的大段参数；用户消息和有效工具历史不作摘要或删除。

### POST /api/app/run/cancel

```json
{ "runId": "abd5fd94-17c4-4614-ac9e-1441f7ce4b5e" }
```

运行中 → `cancelling`，终止模型请求与任务容器，5 秒内不再产生新的文件或验证副作用；最终进入 `cancelled`。终态运行重复取消直接返回。

## 运行详情

以下接口均为只读，要求登录且为用户本人应用：

- `GET /api/app/run/details?runId=<uuid>`：运行、计划、验证项、活动水位和变更摘要。
- `GET /api/app/run/activities?runId=<uuid>&afterId=<id>&limit=200`：按活动 ID 分页读取公开执行记录。
- `GET /api/app/run/changes?runId=<uuid>&cursor=<id>&limit=100`：按文件行 ID 分页读取净变更。
- `GET /api/app/run/change?runId=<uuid>&fileId=<id>&cursor=<line>&limit=200`：读取不可变快照生成的 unified diff。
- `GET /api/app/run/validation/log?runId=<uuid>&attempt=<n>&check=<name>`：读取单轮、单项验证日志。

计划由 `update_plan` 工具提交；首次修改源码或依赖前必须存在计划。计划步骤状态由 Agent 更新，平台验证结果独立记录。文件变更按“本轮开始前快照 → 本轮停止写入后快照”计算，取消和失败也会记录已落盘改动；旧运行没有快照时返回 `detailsStatus: "incomplete"`，不补造 diff。

每个应用默认保留 1 GiB 详情配额。新运行前会检查空间并预留两份源码上限；配额不足或计量不可用时拒绝新运行，不调用模型，也不删除旧历史。

## 预览

### POST /api/app/preview/start

```json
{ "appId": 3 }
```

构建型项目启动或复用容器；静态项目直接返回可用。返回 `{ status, error, url }`。

### GET /api/app/preview/status?appId=3

返回 `{ status, kind, url, lastError }`，不启动容器。

### POST /api/app/preview/access

```json
{ "appId": 3 }
```

返回 60 秒单次票据：

```json
{
  "ticket": { "ticket": "bd1536a9717d...", "expiresIn": 60 },
  "url": "http://app-3.preview.paimeng.localhost:8080",
  "expiresInSeconds": 60
}
```

前端通过隐藏授权 frame 向 `<url>/__platform/access` 发送 `POST` 表单（`ticket=<ticket>`），不得把票据放入 iframe URL。预览入口校验票据后签发 15 分钟、Host-only、HttpOnly、SameSite=Lax 的 `pm_preview` cookie，并返回 204。页面、资源与 HMR WebSocket 均校验该授权；授权过期返回 401。

### POST /api/app/preview/heartbeat

```json
{ "appId": 3 }
```

主站打开预览期间每 30 秒调用一次，延长授权 15 分钟。无运行且超过 15 分钟没有可见心跳的预览会被回收。

前端同时每 5 分钟重新申请票据并通过隐藏授权 frame 刷新预览 cookie；续期只写入新 cookie，不修改当前 iframe 的 URL，因此不会刷新正在展示的页面。

## 健康检查

- `GET /api/health`：`{ status, uptimeSeconds }`
- `GET /api/health/ready`：检查 PostgreSQL、Redis、运行时镜像；任一失败返回 503。
- `GET /api/v3/api-docs`：OpenAPI 文档。
