# 产品与 API

Paimeng 是个人本地 Web 开发助手。用户新建或打开真实目录，通过对话让助手修改代码、安装项目依赖、运行检查、启动应用并修复错误；首版聚焦 Next.js / React，以本地可用为交付终点。本地服务提供 API，浏览器提供工作区。

前端交互是迭代的第一指导；字段以 [schemas.ts](../src/shared/api/schemas.ts) 为准，依赖以根包清单和锁文件为准。历史决策保留在 [adr/](adr/)，旧条目的适用性待逐项确认。

## 产品边界

- `/` 直接进入工作区，未打开项目时提供新建、打开文件夹和最近打开；取消独立展示首页、草稿转正和内置发布。
- Project 对应本地目录，多个 Chat 共用当前文件；其他编辑器可以直接修改，查看历史改动不改变当前工作区。
- 每轮保留改动与 diff；撤销前检查当前文件，遇到后续修改返回冲突，保护用户的工作。
- 项目内常规读写、项目依赖安装、检查，以及助手管理的项目进程可自动执行；项目外修改、全局安装、删除整个项目、Git 提交和推送单独确认。
- 本地命令使用系统用户权限。工作目录不构成操作系统隔离；不再实现沙箱运行或托管发布设施。
- 模板与技能保留。模板是扩展，不阻塞本地开发主线；用户模型配置需要支持，配置界面与多服务管理延后，模型入口已支持本地环境变量，工作区对话仍是示例。
- 模型凭据留在助手本地，不发给浏览器、不写入用户源码、不继承给项目进程。工作台默认只监听回环地址。

## 当前实现

当前 HTTP handler 主要调用 `src/mock/`，状态保存在 `data/mock/state.json`。示例对话、工具、检查和预览用于验证界面；真实磁盘目录、项目进程和模型调用尚未接通。下文只描述现有接口，不表示这些真实能力已经完成。

Project 的 `workspacePath` 表达目录位置，`workspaceState` 区分 `sample` 与 `linked`；当前只产生 `sample`。`Project.files`、`site`、`changeSets` 和 `runtime` 是项目共享状态，Chat 只保存任务对话。`ChangeSet.before/after` 用于 diff 和冲突检测，历史记录不能切换当前文件或预览。

## 约定

- JSON 接口失败返回 `{ error: string }`，状态码区分 `400` 入参、`403` 权限、`404` 不存在、`409` 冲突、`500` 异常、`501` 尚未实现。
- 字段与 SSE 事件以共享 Zod schema 为准；时间为 ISO 8601，`FileMap` 为路径到文本内容的映射。
- 前端只经 `src/lib/api` 请求 `/api/**`；生成结束后重新读取服务端状态。
- 移除项目记录不等于删除磁盘目录；删除整个目录需要独立确认与能力实现。

## 项目与扩展目录

| 方法     | 路径                    | 请求                                                       | 响应与行为                                                                                      |
| -------- | ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`    | `/api/projects`         | —                                                          | `{ projects: ProjectSummary[] }`，包括目录、对话数、改动数、最近对话与缩略图                    |
| `POST`   | `/api/projects`         | `{ workspacePath, name?, prompt?, templateId?, modelId? }` | `201 { project, chat }`；当前只创建示例项目和空对话，不创建磁盘目录                             |
| `POST`   | `/api/projects/open`    | `{ workspacePath }`                                        | 当前返回 `501`，明确没有连接真实目录，不创建伪连接                                              |
| `PATCH`  | `/api/projects/:id`     | `{ name }`                                                 | `Project`                                                                                       |
| `DELETE` | `/api/projects/:id`     | —                                                          | `204`，只移除项目与对话记录，不触碰磁盘目录                                                     |
| `PUT`    | `/api/projects/:id/env` | `{ env: { key, value, secret }[] }`                        | `Project`，覆盖示例环境变量列表；尚不注入真实进程                                               |
| `GET`    | `/api/templates`        | —                                                          | `{ templates: Template[], gallery: GalleryTemplate[] }`，模板扩展保留                           |
| `GET`    | `/api/models`           | —                                                          | `{ models: Model[] }`，当前是示例清单，无配置表单或真实连接                                     |
| `GET`    | `/api/health`           | —                                                          | `{ ok, database }`；检查 SQLite 文件能否连接及查询，失败返回 `503`，不表示业务 API 已迁入数据库 |

`templateId` 缺省为 `auto`，`prompt` 缺省为空。示例项目的路径不代表目录已经存在或获得文件访问权。

## 对话与生成

| 方法    | 路径                                | 请求                                | 响应与行为                                                         |
| ------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `GET`   | `/api/projects/:id/chats`           | —                                   | `{ chats: ChatSummary[] }`                                         |
| `POST`  | `/api/projects/:id/chats`           | `{ modelId?, title? }`              | `201 ChatSummary`；新对话继续使用同一项目的当前文件                |
| `GET`   | `/api/chats?archived=1`             | —                                   | `{ chats: ChatSummary[] }`；不带归档参数时返回空列表               |
| `GET`   | `/api/chats/:id`                    | —                                   | `ChatBundle`：`{ project, chat, chats, messages, skills, models }` |
| `PATCH` | `/api/chats/:id`                    | `{ modelId?, title? }`              | `ChatSummary`                                                      |
| `POST`  | `/api/chats/:id/archive`            | —                                   | `ChatSummary`，生成中返回 `409`                                    |
| `POST`  | `/api/chats/:id/restore`            | —                                   | `ChatSummary`                                                      |
| `POST`  | `/api/chats/:id/messages`           | `{ text, attachments, selection? }` | `202 { messageId, eventsUrl }`                                     |
| `GET`   | `/api/chats/:id/events?since=<seq>` | —                                   | SSE；先给当前消息快照，再推送之后的增量                            |
| `POST`  | `/api/chats/:id/stop`               | —                                   | `202 { ok: true }`，停止示例回合，保留已经产生的改动               |
| `POST`  | `/api/chats/:id/plans/:messageId`   | `{ decision, feedback? }`           | `202 { messageId, eventsUrl }`；要求修改时必须带反馈               |

`attachments` 为 `{ name, dataUrl }[]`。`decision` 为 `approved`、`changes_requested` 或 `rejected`。计划审批、Todo 与审查卡片沿用现有交互；它们的演示不代表真实工具已经执行。

### SSE

每条消息是一行 `data: <json>`，带单调递增的 `seq`。连接先返回权威消息快照；快照已包含的文字和片段不重复追加。

| 事件           | 载荷                                                              |
| -------------- | ----------------------------------------------------------------- |
| `snapshot`     | `{ message: Message \| null }`                                    |
| `part-added`   | `{ messageId, part }`                                             |
| `part-updated` | `{ messageId, partId, patch }`                                    |
| `text-delta`   | `{ messageId, partId, delta }`                                    |
| `preview`      | `{ site, files }`，示例回合中的当前预览与文件                     |
| `finish`       | `{ messageId, status, summary, changeSetId, completionReviewed }` |
| `error`        | `{ message }`                                                     |

`status` 为 `running`、`awaiting_approval`、`succeeded`、`stopped`、`failed`、`budget_exhausted` 或 `rejected`。工具、Todo、Plan、图片、元素选择和 review 都是结构化 Message parts。审查结论绑定源码修订，`completionReviewed` 只描述该轮最终修订；检查结果失效后不能复用旧通过记录。

## 改动与撤销

| 方法   | 路径                                             | 请求 | 响应与行为                                                             |
| ------ | ------------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| `POST` | `/api/projects/:id/changesets/:changeSetId/undo` | —    | `{ project, changeSet }`；已撤销、有后续冲突或项目正在生成时返回 `409` |

改动记录在 `Project.changeSets` 中。撤销只处理本轮涉及的文件：当前内容仍等于记录的 `after` 时恢复 `before`；有冲突则整次拒绝，不覆盖部分文件。不相关文件保留。当前逻辑验证的是示例文件状态，真实磁盘撤销尚未接通。

## 本地文件与命令工具

保留专用的读取、写入、精确编辑、路径查找、内容搜索、移动和删除工具；Bash 用于安装项目依赖、运行检查和启动项目。工具范围以当前 Project 的真实目录为准，覆盖前核对文件修订，检测外部编辑器的后续修改。Plan 期间由宿主收起写类工具和通用命令。

文件读写与进程执行优先使用 Node 原生 `fs`、`child_process`，暂不引入额外文件或进程封装库。路径检查和工具授权不构成操作系统隔离。以上为已确认的执行约定，真实项目文件与命令工具尚未接入工作区；[ADR 0012](adr/0012-dedicated-file-tools-over-bash.md) 保留历史记录，其旧 Chat 沙箱范围由当前 Project 目录约定替代。

## Agent 与审查

Plan 由同一个主 Agent 完成：进入时宿主只开放读取、搜索和技能读取；提交方案后等待用户批准、要求修改或拒绝，批准后由原 Agent 继续执行。批准只对该版方案有效，方案改变需重新审批。Todo 表达执行进度，不能代替检查结果；不增加独立 Planner subagent。真实执行器尚未接入，当前审批界面仍由 mock 驱动；原始决定见 [ADR 0011](adr/0011-plan-mode-as-approval-gate.md)。

主 Agent 使用 `ToolLoopAgent` 执行任务。code review 和 completion review 各是一个独立的只读 subagent：分别使用自己的模型、指令与上下文，经 `request_code_review`、`request_completion_review` 工具供主 Agent 调用。code review 检查改动本身，completion review 核对本轮目标；只读取相关文件、diff、当前修订的检查结果和用户目标，不继承主 Agent 的推理过程，不修改项目或扩大权限。

小改动可以只做确定性检查；大改动在检查通过后调用 code review，交付前调用 completion review。每次子审查的轮次、范围、修订及结论记录在 review 片段中。两者不是固定的一对一流水线。检查结果绑定当前文件修订，无有效通过记录时宿主拒绝成功状态；未经完成审查的成功轮次保留可见标记。

这是已确认的执行定义；当前 UI 和 mock 只演示审查片段，真实主 Agent 与两个 subagent 尚未接入工作区。原始决定见 [ADR 0010](adr/0010-host-ci-floor.md) 和 [ADR 0013](adr/0013-review-as-subagent-tools.md)。

离线评测集、评测指标和夜间自动调优产出 PR 延后交付，保留为后续方向；不作为首版本地开发闭环的前置条件。日常测试、确定性检查和两个审查 subagent 继续保留。[ADR 0014](adr/0014-seeded-defects-as-ground-truth.md) 与 [ADR 0015](adr/0015-offline-tuning-only.md) 保留历史记录。

## 技能

技能采用 Pi 的按需加载方式：发现阶段只索引 `SKILL.md` 的名称、描述和位置；主模型按任务读取正文，引用文件相对技能目录解析，`references/` 与 `scripts/` 需要时再读取。读取脚本不等于授权执行。用户级目录为 `~/.paimeng/skills/<name>/SKILL.md`，所有项目共享；项目级目录为 `<用户项目>/.paimeng/skills/<name>/SKILL.md`。先发现用户级、再发现项目级，同名保留先发现的一份并返回冲突提示；不静默覆盖。技能目录可以分组嵌套，遇到 `SKILL.md` 后把该目录视为一个技能，不继续扫描其参考目录。`disable-model-invocation: true` 的技能不进入自动选择提示，仍可按名称显式读取。

本地技能发现及只读文件接口已接入。列表只返回名称、描述和路径，正文按请求读取；参考文件与脚本文本只能从该技能目录内读取。当前未连接真实目录的示例项目不会触发项目级扫描，用户级扫描正常工作；现有导入、开关和制作操作仍作用于示例技能，不写入用户技能目录。`load_skill`、`read_skill_file` 已提供 AI SDK 只读工具入口，等待真实主 Agent 接入。

| 方法     | 路径                                                         | 请求                                                           | 响应与行为                                                                                                         |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/skills?projectId=<id>`                                 | —                                                              | `{ skills: Skill[], catalog: { skills: LocalSkill[], directories, diagnostics } }`；不传项目时只发现用户级技能     |
| `GET`    | `/api/skills/:slug/files?projectId=<id>&path=<relativePath>` | —                                                              | `{ name, path, content }`；这里只读取本地技能，slug 为技能名，path 默认 `SKILL.md`；越界返回 `403`，过大返回 `413` |
| `PATCH`  | `/api/skills/:slug`                                          | `{ enabled?, trusted? }`                                       | `Skill`；撤销信任同时停用                                                                                          |
| `POST`   | `/api/skills/import`                                         | `{ files: { path, content }[], trusted, slug?, description? }` | `201 Skill`；必须含根 `SKILL.md`                                                                                   |
| `POST`   | `/api/skills/draft`                                          | `{ prompt }`                                                   | `{ slug, files, manifest }`，只生成技能草稿内容                                                                    |
| `DELETE` | `/api/skills/:slug`                                          | —                                                              | `204`，内置技能返回 `403`                                                                                          |

`slug` 的 API 标识区分 `builtin:` 与 `user:` 来源。技能草稿保留；它与已移除的项目草稿不是同一概念。

## 页面

| 路径             | 页面                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `/`              | 工作区空态：打开、新建、最近项目；同一外壳可查看项目、对话、技能与模板 |
| `/chat/<chatId>` | 项目工作区：对话、当前预览、当前文件、改动、运行日志与项目设置         |
| `/skills`        | 技能管理入口                                                           |

## 已接入的基础依赖

使用 AI SDK `ToolLoopAgent` 与 OpenAI-compatible provider；服务端模型入口读取 `AI_MODEL`、`AI_BASE_URL` 和 `AI_API_KEY`，配置表单延后。兼容接口通过本地测试服务验证，未调用收费模型，也未把工作区示例切成真实 Agent。

助手回复使用 `react-markdown` + `remark-gfm`，支持表格、任务列表和代码块；用户消息保持纯文本，不渲染回复中的原始 HTML。只读代码面板使用 Shiki，按需加载语言与明暗主题，语法资源未就绪或文件过大时显示纯文本，不影响源码查看与复制。

文件行差异使用 `diff` 库，保留改动面板的增删行、行号和空行语义；它只负责比较，不负责文件撤销或冲突处理。

存储使用 Drizzle + better-sqlite3，`DATABASE_PATH` 缺省为 `data/paimeng.sqlite`。运行 `npm run db:migrate` 初始化表，可重复执行；迁移内容变动会被校验和拒绝。健康检查只证明数据库可连接和查询，项目/对话等接口仍使用 mock 存储。SQLite 表已去除发布、沙箱和旧版本预设；Git 版本能力另行接入。中断后保留工作、用户重试，不做自动续跑。
