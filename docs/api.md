# 前端 API 契约

前端只通过这里列出的 HTTP 接口取数与写入。当前实现是 mock：`src/app/api/**` 的 handler 调用 `src/mock/world.ts`，数据落盘在 `data/mock/state.json`。

后端接手时逐个替换 handler 内部实现即可，前端调用点、路径、请求体、响应形状、SSE 事件名都不改。字段命名的权威来源是 `src/shared/api/schemas.ts`（zod），本文与它同步。契约字段到数据库表的对应见下文「契约与表结构」：两者不一致时以契约为准，迁移按契约补齐。

## 约定

- 全部返回 `application/json`，除两条 `text/event-stream` 接口。
- 失败统一 `{ "error": "人类可读的说明" }`，配以下状态码：`400` 入参不合法、`403` 不允许（如删除内置技能）、`404` 资源不存在、`409` 状态冲突（如本轮还在生成）、`500` 未预期失败。
- 时间一律 ISO 8601 字符串；`FileMap` 是 `Record<path, content>`。
- 单用户本地优先：没有鉴权头，也不接受 `user_id` 入参。
- 生成中的 assistant 消息由服务端持有；客户端通过 SSE 跟随后，在 `finish` 后重新 `GET /api/chats/:id` 取权威状态。

### 契约与表结构

迁移 `001_init.sql` 目前只建了表，字段还没对齐契约。实现时按下表补齐，不另建派生表。

| 契约                                                                       | 落在哪                                  | 现状                                      |
| -------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `ChatSummary.projectId` 可空，草稿为 `null`                                | `chat.project_id`                       | 迁移是 `not null`，需放行                 |
| `ChatSummary.draft`                                                        | `chat.draft` jsonb                      | 迁移缺列                                  |
| `ChatSummary.archivedAt`                                                   | `chat.archived_at`                      | 迁移缺列                                  |
| `Project.prompt`、`Project.templateId`                                     | `project.prompt`、`project.template_id` | 迁移缺列                                  |
| `Project.updatedAt`                                                        | `project.updated_at`                    | 迁移缺列                                  |
| `Project.deployKey`、`Project.deploys`                                     | `deploy` 表聚合                         | 不落 `project` 表                         |
| `Version.files`、`Version.site`、`changedFiles`                            | `version.snapshot_path` 指向的源码树    | 列表端点不返回整棵树                      |
| `ChatSummary.streaming`、`activeVersionId`、`viewVersionId`、`pendingPlan` | 无列                                    | 由 message parts 与进程内状态推导，不入库 |

## 健康检查

| 方法  | 路径          | 请求 | 响应                                                                                   |
| ----- | ------------- | ---- | -------------------------------------------------------------------------------------- |
| `GET` | `/api/health` | —    | `{ ok, database }`；数据库可达返回 `200`，否则 `503` 且 `ok` 为 `false`（M0 退出条件） |

## 项目与目录

| 方法     | 路径                    | 请求                                | 响应                                                                          |
| -------- | ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `GET`    | `/api/projects`         | —                                   | `{ projects: (Project & { chatCount, versionCount, lastChatId, thumb })[] }`  |
| `POST`   | `/api/projects`         | `{ prompt, templateId, modelId? }`  | `{ project, chat }`；直接从描述建项目，前端已不用（改走草稿），保留给脚本复用 |
| `PATCH`  | `/api/projects/:id`     | `{ name }`                          | `Project`                                                                     |
| `DELETE` | `/api/projects/:id`     | —                                   | `204`                                                                         |
| `PUT`    | `/api/projects/:id/env` | `{ env: { key, value, secret }[] }` | `Project`（整表覆盖，空 key 的行会被丢弃）                                    |
| `GET`    | `/api/templates`        | —                                   | `{ templates: Template[], gallery: GalleryTemplate[] }`                       |
| `GET`    | `/api/models`           | —                                   | `{ models: Model[] }`                                                         |

`templateId: "auto"` 表示由生成模型决定结构。首页与模板卡都只建 Draft；用户点「创建项目」才产生 Project，之后「发布」才部署。`GalleryTemplate.site` 是首页卡片缩略图用的站点状态，不参与生成。

## 对话与生成

| 方法    | 路径                                | 请求                                | 响应                                                                                                                                                                              |
| ------- | ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/projects/:id/chats`           | —                                   | `{ chats: ChatSummary[] }`                                                                                                                                                        |
| `POST`  | `/api/projects/:id/chats`           | `{ modelId?, title? }`              | `ChatSummary`；起点版本复制项目当前源码树                                                                                                                                         |
| `POST`  | `/api/chats`                        | `{ prompt, templateId, modelId? }`  | `201 { chat, eventsUrl }`；建**草稿**并开始首轮，`chat.projectId` 为 `null`                                                                                                       |
| `GET`   | `/api/chats?archived=1`             | —                                   | `{ chats: ChatSummary[] }`；归档会话，按归档时间倒序。不带 `archived=1` 时返回空列表占位，前端不使用；默认列表由 `/api/drafts`、`/api/projects` 与 `/api/projects/:id/chats` 提供 |
| `GET`   | `/api/drafts`                       | —                                   | `{ chats: ChatSummary[] }`；还没有项目的会话（不含归档），按更新时间倒序                                                                                                          |
| `GET`   | `/api/chats/:id`                    | —                                   | `ChatBundle`：`{ project, chat, chats, messages, versions, skills }`；草稿的 `project` 为 `null`                                                                                  |
| `POST`  | `/api/chats/:id/project`            | —                                   | `201 { project, chat }`；草稿转项目，会话与版本原地保留，**不部署**；已是项目返回 409                                                                                             |
| `PATCH` | `/api/chats/:id`                    | `{ modelId?, title? }`              | `ChatSummary`                                                                                                                                                                     |
| `POST`  | `/api/chats/:id/archive`            | —                                   | `ChatSummary`；归档不是删除，`archivedAt` 有值后从默认列表消失；生成中返回 409                                                                                                    |
| `POST`  | `/api/chats/:id/restore`            | —                                   | `ChatSummary`；取消归档，`archivedAt` 置空                                                                                                                                        |
| `POST`  | `/api/chats/:id/messages`           | `{ text, attachments, selection? }` | `202 { messageId, eventsUrl }`                                                                                                                                                    |
| `GET`   | `/api/chats/:id/events?since=<seq>` | —                                   | `text/event-stream`，见下节                                                                                                                                                       |
| `POST`  | `/api/chats/:id/stop`               | —                                   | `202`；本轮转为 `stopped`，已完成的改动保留为版本                                                                                                                                 |
| `POST`  | `/api/chats/:id/plans/:messageId`   | `{ decision, feedback? }`           | `202 { messageId, eventsUrl }`；`changes_requested` 必带非空 `feedback`                                                                                                           |
| `GET`   | `/api/chats/:id/preview`            | —                                   | `{ chatId, versionId, site }`（mock 阶段用本地组件渲染；将来由 `/preview/:chatId` 反代取代）                                                                                      |

输入命中「先规划 / 先做计划 / 先出方案」时（agent 自己判断，不由用户开关指定），本轮只产出 plan 片段与 `awaiting_approval` 状态，不写文件。`attachments[].dataUrl` 是 `data:` URL；服务端落盘后成为 `image` 片段。

### SSE 事件

每条事件是一行 `data: <json>`，`seq` 单调递增。客户端带 `since=<seq>` 重连时只补发更大的 `seq`；不带时从头补发本轮全部事件。

| 事件           | 载荷                                                                             | 含义                                                                                |
| -------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `snapshot`     | `{ message: Message \| null }`                                                   | 连接建立或新一轮开始时，客户端用它替换当前生成中的消息                              |
| `part-added`   | `{ messageId, part }`                                                            | 追加一个片段（text / reasoning / tool / todos / plan / selection / image / review） |
| `part-updated` | `{ messageId, partId, patch: { state?, output?, items?, verdict?, findings? } }` | 工具状态与输出、Todo 进度、审查结论与打回理由                                       |
| `text-delta`   | `{ messageId, partId, delta }`                                                   | 文本增量                                                                            |
| `finish`       | `{ messageId, status, summary, versionId, completionReviewed }`                  | 本轮结束；随后客户端重取 `ChatBundle`                                               |
| `preview`      | `{ site, files }`                                                                | 生成中的预览状态与源码树（mock 阶段用本地组件渲染）                                 |
| `error`        | `{ message }`                                                                    | 服务端失败；前端提示后可重试                                                        |

`status` 取值：`running`、`awaiting_approval`、`succeeded`、`stopped`、`failed`、`budget_exhausted`、`rejected`。

### 审查片段与完成标记

开发反馈循环的设计见 `architecture.md` 第 6.1 节。CI 是普通工具片段（`name: "run_checks"`，输入带 `revision` 与 `checks`）；两个 review subagent 的每次调用是一个 `review` 片段，不再另发 tool 片段。

| 字段       | 取值                                 | 含义                                                                       |
| ---------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `kind`     | `code` / `completion`                | code review 检查改动本身；completion review 交付前核对本轮目标             |
| `round`    | 正整数                               | 按 `kind` 各自从 1 计数                                                    |
| `revision` | 源码修订指纹                         | 被审的那一版；之后再改文件，结论不再适用                                   |
| `scope`    | 文本                                 | 这次审查覆盖的范围，可以只是局部                                           |
| `state`    | `running` / `done` / `error`         | `error` 表示没有结论，例如当前修订没有 CI 通过记录、审查没有开始，或被中断 |
| `verdict`  | `passed` / `changes_requested`，可缺 | `state` 为 `done` 时才有                                                   |
| `findings` | 文本数组，可缺                       | 打回理由或没有结论的原因                                                   |

`completionReviewed` 同时出现在 `finish` 与 `Message` 上：本轮成功，且最后一版源码修订通过了 completion review 时为 `true`。成功但为 `false` 时界面标「未经完成审查」；旧消息没有这个字段时不标。宿主底线：当前修订没有 CI 通过记录时，`status` 不会是 `succeeded`。

## 版本

| 方法   | 路径                                          | 响应                                                                                    |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/api/chats/:id/versions`                     | `{ versions: Version[] }`                                                               |
| `GET`  | `/api/chats/:id/versions/:versionId/files`    | `{ versionId, files, site }`                                                            |
| `GET`  | `/api/chats/:id/versions/:versionId/diff`     | `{ versionId, files: { path, status, added, removed, before, after }[] }`，与上一版比对 |
| `POST` | `/api/chats/:id/versions/:versionId/rollback` | `Version`；追加新版本，不修改历史                                                       |

## 发布

| 方法   | 路径                             | 请求            | 响应                                                                                          |
| ------ | -------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `POST` | `/api/projects/:id/deploys`      | `{ versionId }` | `201 { deploy, eventsUrl }`                                                                   |
| `GET`  | `/api/deploys/:deployKey/events` | —               | `text/event-stream`：`{ type: "step", step, state }` … `{ type: "finish", deployKey, state }` |
| `GET`  | `/api/projects/:id/deploys`      | —               | `{ deploys: Deploy[] }`                                                                       |
| `GET`  | `/api/deploys/:deployKey`        | —               | `{ project, deploy, version }`；发布页 `/deploys/<deployKey>` 用它                            |

发布地址按 Project 固定：第一次发布生成 `deployKey`，之后同一 Project 的再次发布复用同一个 key，指向新版本。

## 技能

| 方法     | 路径                 | 请求                                                           | 响应                                              |
| -------- | -------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `GET`    | `/api/skills`        | —                                                              | `{ skills: Skill[] }`                             |
| `PATCH`  | `/api/skills/:slug`  | `{ enabled?, trusted? }`                                       | `Skill`；`trusted: false` 同时置 `enabled: false` |
| `POST`   | `/api/skills/import` | `{ files: { path, content }[], trusted, slug?, description? }` | `Skill`；必须含根 `SKILL.md`                      |
| `POST`   | `/api/skills/draft`  | `{ prompt }`                                                   | `{ slug, files, manifest }`，仅草稿，不落库       |
| `DELETE` | `/api/skills/:slug`  | —                                                              | `204`；内置技能返回 `403`                         |

`slug` 形如 `user:brand-voice` 或 `builtin:nextjs`，与 `Skill.source` 一起构成唯一键。

## mock 行为

这些是 mock 阶段的行为，后端实现时由真实能力替代；接口形状不变。

- 场景由输入决定，不再有 UI 开关：默认完整一轮；「先规划」出方案；含「验证失败」「修复」→ 先失败再修复；含「失败」→ 检查失败；含「上限」→ `budget_exhausted`；含「证据」→ 旧证据失效后重新检查；含「八项工具」→ 依次演示文件工具；含「脚本」且技能未信任 → 拒绝执行。
- 检查与构建是固定剧情：不跑编译器、不执行命令、不联网，工具输出里不会声称真实通过。
- 预览用本地组件渲染 `SiteState`，不跑沙箱；`/api/chats/:id/preview` 只返回该状态。
- 发布逐帧推送固定构建步骤，产物不真实存在；`/deploys/<deployKey>` 渲染 `Version.site`。
- 状态落盘在 `data/mock/state.json`（`data/` 已 gitignore），文件损坏或 schema 不匹配时回落到种子并写一条日志。

## 错误与状态码

| 场景                        | 状态码 | 说明                                        |
| --------------------------- | ------ | ------------------------------------------- |
| 请求体不合法                | `400`  | zod 校验失败，`error` 里指出哪个字段        |
| 对话线正在生成              | `409`  | 再发消息或审批前需先 `stop` 或等待 `finish` |
| 删除内置技能                | `403`  | 内置技能只读                                |
| 未知项目/对话/版本/发布 key | `404`  | —                                           |

## 前端路由

页面路由用业务词，扁平，不带 `/prototype` 前缀：

| 路径                   | 页面                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `/`                    | 首页：一句话开草稿、模板画廊、最近项目                                                            |
| `/chat/<chatId>`       | 工作区：左栏对话线；中栏可切对话 / 全部对话（含归档）/ 项目列表与项目概览 / 技能 / 模板，不换路由 |
| `/skills`              | 技能：启停、信任、导入、草稿                                                                      |
| `/deploys/<deployKey>` | 已发布站点（独立外观，不含工作台 chrome）                                                         |
