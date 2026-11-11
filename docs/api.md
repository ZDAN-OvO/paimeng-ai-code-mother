# 产品与 API

派蒙是个人本地 Web 开发助手。用户在浏览器里打开一个已存在的本地目录，通过对话让 Agent 读取、修改和运行项目内的文件与命令。项目文件以磁盘为准，对话、运行记录和改动记录保存在本地 SQLite；不会复制一份项目源码到数据库。

前端交互是产品迭代的第一指导；字段以 [schemas.ts](../src/shared/api/schemas.ts) 为准，依赖以根包清单和锁文件为准。历史决策保留在 [adr/](adr/)。

## 产品边界

- 首页用于打开本地目录、继续最近项目和查看模板画廊。打开目录不创建或复制目录，也不要求目录里已有 `package.json`。
- 一个项目对应一个真实目录，可以有多个对话。同一对话同时只能跑一轮；同一项目的不同对话可以并行。
- Agent 可以使用 `read`、`write`、`edit`、`grep`、`find`、`ls` 和 `bash`。文件工具只作用于项目目录；Bash 在项目目录执行，并剔除宿主模型凭据等密钥环境变量。
- 覆盖已有文件前必须先读取。读取后文件被外部修改时，本次写入被拒绝，工具把冲突和最近写入来源返回给模型，模型重新读取后可以继续合并。
- `sudo`、全局安装、`git commit/push`、明显指向项目外的 `rm/mv` 会让该次工具调用暂停等待用户批准。关键词规则不是操作系统隔离，Bash 仍使用当前系统用户权限。
- 每轮按运行回合记录文件改动和 Diff。改动可以按文件恢复；恢复不检查当前文件是否等于改后内容，会直接覆盖到该 Diff 的改前状态。首版没有整轮撤销、单次工具撤销或逐段撤销。
- 项目内快照使用 `data/` 下独立的 Git 对象库，不触碰用户仓库的索引、分支和工作树。被 `.gitignore` 和固定依赖目录忽略的内容不进入文件树、Diff 或撤销。
- 删除项目只删除派蒙自己的项目记录、对话、改动记录、快照和命令输出，不删除磁盘目录。运行中或等待批准的对话会拒绝删除。
- 模板保留为扩展入口；本片不启动示例项目。技能页只发现并查看用户级和项目级磁盘技能，不把技能注入 Agent。应用启动和预览、Plan、独立 review subagent、后台任务和模型配置界面延后。

## 约定

- 失败返回 `{ error: string }`。`400` 入参或路径不合法，`403` 越界或权限拒绝，`404` 不存在，`409` 状态冲突，`500` 未预期错误。
- 时间为 ISO 8601。项目文件内容不放在项目列表响应里，只在请求具体文件时读取。
- 前端只通过 `src/lib/api/client.ts` 请求 `/api/**`。SSE 每条消息是一行 `data: <json>`。
- 所有事件都带单调递增的 `seq` 和 `runId`。`GET /api/chats/:id/events?since=<seq>` 先返回权威 `snapshot`，再推送之后的增量；终态且没有内存事件时从 SQLite 返回终态快照并结束。
- `FileWindow.binary=true` 时不返回文本内容。默认最多 2000 行或 50 KiB，`nextOffset` 用于继续读取。

## 项目与文件

| 方法     | 路径                           | 请求                    | 响应与行为                                                                                             |
| -------- | ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/projects`                | —                       | `{ projects: ProjectSummary[] }`；最近打开、目录、对话数、改动数和最近对话                             |
| `POST`   | `/api/projects/open`           | `{ workspacePath }`     | `201 { project, chats }`；路径必须绝对、存在且是目录；同一真实路径（含软链）复用已有项目并返回入口对话 |
| `GET`    | `/api/projects/:id`            | —                       | `ProjectDetail`：`{ project, chats, changeSets, nextCursor }`                                          |
| `PATCH`  | `/api/projects/:id`            | `{ name }`              | `Project`                                                                                              |
| `DELETE` | `/api/projects/:id`            | —                       | `204`；只删派蒙记录和 `data/` 下项目数据，不触碰用户目录；有运行中/待批准轮次返回 `409`                |
| `GET`    | `/api/projects/:id/file`       | `?path=&offset=&limit=` | `FileWindow`；按需读取项目内文本文件，越界路径拒绝                                                     |
| `GET`    | `/api/projects/:id/changesets` | `?cursor=&limit=`       | `{ changeSets: ChangeSet[], nextCursor }`                                                              |

打开目录会拒绝根目录、用户家目录、派蒙安装目录，以及项目目录之外的路径。项目目录之后被移走或失去权限时，读取返回具体错误，不重建目录、不切换到其他目录。列表与索引默认忽略 `.git`、`node_modules`、`.next`、`dist`、`build`、`coverage` 和 `.gitignore` 命中的内容，并返回截断标志；已知路径仍可显式读取，因此索引过滤不是访问边界。

## 对话与运行

| 方法    | 路径                                               | 请求                                     | 响应与行为                                                                    |
| ------- | -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET`   | `/api/projects/:id/chats`                          | —                                        | `{ chats: ChatSummary[] }`                                                    |
| `POST`  | `/api/projects/:id/chats`                          | `{ modelId?, title? }`                   | `201 ChatSummary`                                                             |
| `GET`   | `/api/chats`                                       | `?archived=1`                            | `{ chats: ChatSummary[] }`                                                    |
| `GET`   | `/api/chats/:id`                                   | —                                        | `ChatBundle`：`{ project, chat, chats, messages, skills, models }`            |
| `PATCH` | `/api/chats/:id`                                   | `{ modelId?, title? }`                   | `ChatSummary`                                                                 |
| `POST`  | `/api/chats/:id/archive`                           | —                                        | `ChatSummary`；运行中返回 `409`                                               |
| `POST`  | `/api/chats/:id/restore`                           | —                                        | `ChatSummary`                                                                 |
| `POST`  | `/api/chats/:id/messages`                          | `{ text }`                               | `202 { runId, messageId, eventsUrl }`；同一对话已有运行或待批准轮次返回 `409` |
| `GET`   | `/api/chats/:id/events`                            | `?since=<seq>`                           | SSE；`snapshot` + 增量事件                                                    |
| `POST`  | `/api/chats/:id/stop`                              | —                                        | `202 { ok: true }`；幂等；终止模型请求和 Bash，等待已写文件收尾               |
| `POST`  | `/api/chats/:id/runs/:runId/approvals/:approvalId` | `{ decision: "approved" \| "rejected" }` | `{ ok: true, approval }`；只允许 pending 改变，重复/过期返回 `409`            |

运行状态为 `running`、`awaiting_approval`、`succeeded`、`stopped`、`failed`。停止原因为 `user_stop` 或 `service_restart`。服务重启后遗留的运行会被标记 `stopped/service_restart`，已落盘的 Bash 改动按快照补记，无法确认写入者的改动标为 `uncertain`；不会自动续跑、重放工具或恢复旧审批。正常结束但仍有待执行工具时，状态是 `succeeded`，界面只显示本轮已结束。

Agent 不设整轮步数、总时长或重复失败预算；模型调用不启用宿主自动重试。工具错误、单条 Bash 超时、审批拒绝和文件版本冲突作为工具结果返回给模型继续。停止、崩溃、致命模型/数据库错误会结束当前轮，并保留已经写入的文件供 Diff 恢复。

### SSE 事件

| 事件            | 载荷                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| `snapshot`      | `{ message: Message \| null, run: { id, status, messageId } \| null }`                  |
| `part-added`    | `{ messageId, part }`                                                                   |
| `part-updated`  | `{ messageId, partId, patch }`；patch 可含 `state`、`output`、`error`、`approvalStatus` |
| `text-delta`    | `{ messageId, partId, delta }`                                                          |
| `files-changed` | `{ changeSetId, paths }`                                                                |
| `finish`        | `{ messageId, status, stopReason, summary, changeSetId, error }`                        |
| `error`         | `{ message }`                                                                           |

消息片段只有 `text`、`tool` 和 `approval`。工具片段包含名称、输入、状态、输出或错误；审批片段包含固定命令、工作目录、原因和状态。连接中断后前端从最后 `seq` 重连；快照是权威状态，避免重复文本。

## 改动与恢复

| 方法   | 路径                                             | 请求       | 响应与行为                                               |
| ------ | ------------------------------------------------ | ---------- | -------------------------------------------------------- |
| `GET`  | `/api/projects/:id/changesets/:changeSetId/file` | `?path=`   | `{ changeSet, file, before, after }`；文本 Diff 按需读取 |
| `POST` | `/api/projects/:id/changesets/:changeSetId/undo` | `{ path }` | `{ changeSet, file }`；只恢复所选文件                    |

`ChangeFile` 记录路径、新增/修改/删除、来源（`tool`、`bash`、`user_undo`、`mixed`）、归属（`exact` 或 `uncertain`）、撤销状态、增删行数和二进制标记。ChangeSet 状态由文件状态推导为 `applied`、`partially_undone` 或 `undone`。

撤销先阻止同项目新的写入，终止并收尾正在运行的 Bash，再恢复所选文件。新增文件的撤销是删除，删除文件的撤销是恢复，空文件和缺失文件区分处理。撤销成功后会使其他运行对该文件的旧观察失效，并通知相关 Agent 重新读取、不要自动重做被撤销的改动；被终止的 Bash 把 `user_undo` 作为工具错误返回，所在轮次继续。撤销优先只保证本次恢复先完成，不是永久文件锁。

## Agent 工具、审批与快照

| 工具    | 行为                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------- |
| `read`  | 1 起算的行号、offset/limit、最多 2000 行或 50 KiB、截断和续读提示；流式读取                        |
| `write` | 创建或覆盖；自动建父目录；覆盖前必须已读；新文件不覆盖已存在文件；原子提交                         |
| `edit`  | 多个 `{ oldText, newText }` 对同一原文定位，必须唯一且互不重叠；保留 BOM、未改行和原换行风格       |
| `grep`  | 固定参数调用打包的 ripgrep，不经 shell、不读取用户 rg 配置；默认最多 100 条                        |
| `find`  | 项目相对路径 glob，最多 1000 条                                                                    |
| `ls`    | 项目内目录列表，最多 500 条                                                                        |
| `bash`  | `bash -c`，cwd 为项目目录，默认 120 秒、最大 600 秒；全量输出落盘，模型只接收尾部 2000 行或 50 KiB |

路径解析对已有目标使用 `realpath`，新路径校验最近存在父目录；拒绝 `..`、越界绝对路径和越界软链。观察状态按运行隔离，记录 `dev/ino/size/mtimeNs/ctimeNs`，写前在文件级临界区复核。工具只能协调派蒙自身操作，不能阻止外部编辑器并发写入。

Bash 超时或停止时先向进程组发 `SIGTERM`，3 秒后 `SIGKILL`，并处理管道后代。等待批准时停止按钮有效；批准只执行保存的那条命令一次，参数改变需要重新批准；拒绝不执行命令。审批记录在 SQLite，重启后不会执行旧审批。

每条 Bash 在该命令前后各做一次独立快照，只扫描未忽略内容。文件工具精确记录改动；Bash 快照发现的变化统一按 `uncertain` 处理，因为快照不能证明写入者，界面不能把外部编辑精确归因给某个 Agent。

## 模型与健康检查

| 方法  | 路径          | 响应与行为                                                                                            |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `GET` | `/api/models` | `{ models: Model[] }`；只返回环境变量实际配置的模型标识和可用状态，不含凭据                           |
| `GET` | `/api/health` | `{ ok, node, git, bash, ripgrep, database, problems }`；缺少 Node/Git/Bash 或数据库不可用时返回 `503` |

模型通过 `AI_MODEL`、`AI_BASE_URL`、`AI_API_KEY` 配置，使用 AI SDK `ToolLoopAgent` 和 OpenAI-compatible provider。模型配置界面延后；没有配置时发送消息返回 `400`。

## 技能与模板

| 方法  | 路径                               | 请求 | 响应与行为                                                      |
| ----- | ---------------------------------- | ---- | --------------------------------------------------------------- |
| `GET` | `/api/skills?projectId=<id>`       | —    | `SkillCatalog`：技能列表、用户级/项目级目录和诊断信息           |
| `GET` | `/api/skills/:name?projectId=<id>` | —    | `SkillDetail`：技能信息和技能目录内文本文件内容；越界返回 `403` |
| `GET` | `/api/templates`                   | —    | `{ templates, gallery }`；展示模板画廊，不创建示例项目          |

技能只发现 `~/.paimeng/skills/<name>/SKILL.md` 和 `<项目>/.paimeng/skills/<name>/SKILL.md` 两级目录，同名以先发现者为准并返回诊断。导入、启用、信任、删除和技能草稿接口已下线；技能不会自动注入 Agent。

## 页面

| 路径             | 页面                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `/`              | 打开本地目录、最近项目、模板画廊；未打开项目时为空态                |
| `/chat/<chatId>` | 工作区：对话、项目文件、改动 Diff、审批卡片和停止；预览显示尚未启动 |
| `/skills`        | 用户级和项目级磁盘技能列表与正文查看                                |

## 已接入依赖

- Next.js 16、React 19、AI SDK 7、`@ai-sdk/openai-compatible`、Zod 4。
- Drizzle + better-sqlite3；`DATABASE_PATH` 缺省为 `data/paimeng.sqlite`。运行 `npm run db:migrate` 建表，可重复执行；已应用迁移的校验和变化会被拒绝。
- `diff` 计算行差异；Shiki 按需高亮代码；`react-markdown` + `remark-gfm` 渲染助手回复，用户消息保持纯文本。
- `@vscode/ripgrep`（固定版本）提供打包的搜索二进制。
- 项目快照和 Bash 前后比较需要本机 Git；缺少 Git 时健康检查报告问题并拒绝需要快照的操作。
