# 前端原型（throwaway）

这是 `docs/mvp.md` 里 13 条验收路径的**可点击前端原型**，用 React + Tailwind + shadcn 写在 `src/` 里，用来确认 MVP 是否覆盖需求，并作为后端补接口的依据。

- 入口：`npm run dev` → http://localhost:3000/prototype
- 右下角悬浮条是原型工具：MVP 清单（13 条逐条跳转）、重置演示数据。
- 数据全是模拟的，存在浏览器 localStorage。生产构建里悬浮条不渲染。
- 不需要数据库、Docker、模型密钥。

## 路由

| 路由                    | 对应产品面                             |
| ----------------------- | -------------------------------------- |
| `/prototype`            | 首页：一句话建项目、模板画廊、最近项目 |
| `/prototype/c/<chatId>` | 工作区：左侧栏 + 对话 + 右栏单面板     |
| `/prototype/p/<key>`    | 已发布地址（模拟）                     |
| `/prototype/skills`     | 技能面板（M4，不在 13 条内）           |

## 新增流程演示（仅前端）

- Chat 输入框的「先规划」开关或输入“先规划”会创建只读方案。卡片支持批准、填写意见后要求修改、拒绝；待审状态存 localStorage，刷新仍可处理。旧方案不再出现可用的批准按钮。
- 每轮回复显示 Todo；生成、检查、修复与完成判定由浏览器脚本驱动。工具输出明确标记本地模拟，不调用模型、Shell、网络、数据库或 Docker。
- 输入框的「演示」菜单可触发验证失败后修复、持续失败、达到本轮执行上限、旧证据失效、八项文件工具、未信任脚本拒绝。执行上限指单轮任务的步数、时间或 token 限制，不是费用或用户额度；当前只是模拟状态，没有真实计数或收费。任务未完成时不把剩余 Todo 勾完，也不把停止、失败或达到执行上限显示为成功。
- `verify_project` 与 `complete_task` 是模拟工具。证据绑定本地文件修订，修改后旧证据会被拒绝；这不证明真实编译、执行器隔离或浏览器验证已实现。
- 每条结束的助手消息记录本地版本，包括只读计划、调研与停止后的部分工作；回滚仍追加版本。创建计划不写源码，计划版本可为空源码树。
- Design 选中的组件、路径和标签会随消息保存，并显示在用户消息中；定位仍用 `data-src` 模拟。
- 技能页支持浏览器多文件／目录读取、来源同名区分、实际清单与正文保存在 localStorage。启用用户技能后在 Chat 输入其 slug，会看到模拟 `load_skill`；未信任技能的脚本请求被拒绝，但不实际执行任何脚本。

不要在原型里填写真实密钥或导入敏感技能；全部演示数据保存在浏览器中。生产实现的权限、安全和持久化能力不由此原型保证。

## 哪些是真的，哪些是模拟的

| 部分                       | 原型里的实现                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| 文件内容、文件树、语法着色 | 真实字符串；多轮生成会真的改文件                                      |
| 版本快照、行级 diff、回滚  | 真实行级 diff（LCS），回滚追加新版本                                  |
| 预览                       | 用同一份 content 渲染的本地组件，不跑沙箱                             |
| 流式对话、工具状态         | 脚本按步骤驱动，时序可停止                                            |
| Design mode                | `data-src` 模拟 fiber 的 `_debugSource`，点选后填词                   |
| 发布                       | 只写发布记录并切地址，不构建真实产物                                  |
| 技能                       | 浏览器内文件读取、正文与信任/启用状态；不接后端、不写磁盘、不执行脚本 |
| 新对话                     | 复制项目当前源码树作为起点版本，不带历史消息                          |
| 联网调研                   | 匹配到搜索类描述时不改文件，只出工具卡片与结论                        |
| 明暗主题                   | 跟随系统或手动，存 localStorage；只作用于产品界面                     |
| 语音输入                   | 浏览器 SpeechRecognition；不可用时提示，不接后端                      |
| 右栏面板                   | 预览/代码/diff/日志/设置/产物；数据库与终端标未接通                   |

## 后端接口契约（按前端需要整理）

前端状态形状见 `src/prototype/types.ts`，mock 数据见 `src/prototype/mock-data.ts`。字段名按现有 Drizzle schema（`src/server/db/schema.ts`）对齐。

### 项目与模板

| 方法     | 路径                    | 请求                                     | 响应                                  |
| -------- | ----------------------- | ---------------------------------------- | ------------------------------------- |
| `GET`    | `/api/projects`         | —                                        | `Project[]`（含 `deploys[0]` 与计数） |
| `POST`   | `/api/projects`         | `{ prompt, name?, templateId, modelId }` | `{ project, chat, streamUrl }`        |
| `PATCH`  | `/api/projects/:id`     | `{ name? }`                              | `Project`                             |
| `DELETE` | `/api/projects/:id`     | —                                        | `204`                                 |
| `GET`    | `/api/templates`        | —                                        | `{ id, name, description, prompt }[]` |
| `GET`    | `/api/models`           | —                                        | `{ id, name, provider, note }[]`      |
| `PUT`    | `/api/projects/:id/env` | `{ env: { key, value, secret }[] }`      | `202`，沙箱随后重启                   |

`templateId: "auto"` 表示由生成模型决定结构。

### 对话与生成

| 方法    | 路径                      | 请求                                         | 响应                           |
| ------- | ------------------------- | -------------------------------------------- | ------------------------------ |
| `GET`   | `/api/projects/:id/chats` | —                                            | `Chat[]`                       |
| `POST`  | `/api/projects/:id/chats` | `{ modelId, title? }`                        | `Chat`                         |
| `GET`   | `/api/chats/:id`          | —                                            | `{ chat, messages, versions }` |
| `PATCH` | `/api/chats/:id`          | `{ modelId?, title? }`                       | `Chat`                         |
| `POST`  | `/api/chats/:id/messages` | `{ text, attachments: { name, dataUrl }[] }` | `text/event-stream`            |
| `POST`  | `/api/chats/:id/stop`     | —                                            | `202`；也可直接断开 SSE        |

流事件需要覆盖 UI 已渲染的 part 类型：

```
data: {"type":"reasoning-delta","delta":"..."}
data: {"type":"tool-input-available","toolCallId":"...","toolName":"write_file","input":{...}}
data: {"type":"tool-output-available","toolCallId":"...","output":"..."}
data: {"type":"text-delta","delta":"..."}
data: {"type":"finish","messageId":"...","versionId":"...","seq":4}
data: {"type":"error","message":"..."}
```

原型可展示八项文件工具，以及 `search_web`、`fetch_url`、`load_skill`、`read_skill_file`、`verify_project`、`complete_task`。旧种子消息的 `web_search` 卡片仍兼容。Todo、Plan、Design 定位与终止原因已有前端状态；下列接口表和流事件仅是旧版提案，后端实现前需按当前架构补齐审批与状态协议，不把模拟脚本当成已实现接口。

### 版本、diff、回滚

| 方法   | 路径                                          | 说明                                                                        |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/api/chats/:id/versions`                     | 版本列表：`{ id, seq, messageId, label, summary, changedFiles, createdAt }` |
| `GET`  | `/api/chats/:id/versions/:versionId/files`    | 源码树 `Record<path, content>`                                              |
| `GET`  | `/api/chats/:id/versions/:versionId/diff`     | 与上一版对比：`{ files: [{ path, status, added, removed, patch }] }`        |
| `POST` | `/api/chats/:id/versions/:versionId/rollback` | 追加一个新版本，返回 `Version`                                              |

预览不是 JSON 接口：`/preview/:chatId/*` 反代沙箱里的 `next dev`，同时代理 HMR WebSocket；预览面板只依赖这两条。

### 发布

| 方法   | 路径                        | 请求            | 响应                                                         |
| ------ | --------------------------- | --------------- | ------------------------------------------------------------ |
| `POST` | `/api/projects/:id/deploys` | `{ versionId }` | `{ deployId, eventsUrl }`，前端接 SSE 看构建步骤             |
| `GET`  | `/api/deploys/:id/events`   | —               | `text/event-stream`：`{ step, state }`，结束时给 `deployKey` |
| `GET`  | `/api/projects/:id/deploys` | —               | `Deploy[]`（发布历史）                                       |
| `GET`  | `/p/:deployKey/*`           | —               | 已发布站点（runner 反代）                                    |

发布地址按 Project 固定；回滚产生新版本后重新发布，同一 `deployKey` 指向新版本。

### 技能（M4）

| 方法     | 路径                 | 请求                                      | 响应                                                             |
| -------- | -------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/api/skills`        | —                                         | `{ slug, name, description, source, trusted, enabled, files }[]` |
| `PATCH`  | `/api/skills/:slug`  | `{ enabled?, trusted? }`                  | `Skill`                                                          |
| `POST`   | `/api/skills/import` | `{ files: { path, content }[], trusted }` | `Skill`，未信任时 `enabled=false`                                |
| `POST`   | `/api/skills/draft`  | `{ prompt }`                              | `{ slug, files, manifest }` 供确认                               |
| `POST`   | `/api/skills`        | `{ slug, files, trusted }`                | `Skill`                                                          |
| `DELETE` | `/api/skills/:slug`  | —                                         | `204`（内置技能返回 `403`）                                      |

### Design mode 与截图

- 点选元素不调后端：在预览页里读 React fiber 上的 `_debugSource`，得到 `{ fileName, lineNumber, columnNumber, componentName }`，再拼成一句对话输入。
- 截图走 `POST /api/chats/:id/messages` 的 `attachments`（`dataUrl`），落盘后作为本轮 `image` part。

## 原型已知的取舍

- 预览用本地组件渲染，元素定位用 `data-src` 而不是真实 fiber；接上沙箱后这块要换成 postMessage + `_debugSource`。
- 左栏可折叠、右栏宽度可拖，两个偏好存 localStorage；窄屏不做移动端布局（MVP 明确不做移动端 App）。
- 右栏一次只渲染一个面板，Database 与 Terminal 只出现在「+」菜单里并标「未接通」，不造假数据。
- 模板画廊里的六张卡都是同一套 mock 站点按不同文案与版式渲染的，不是六个独立工程。
- 版本面板一次只展开一版；真实实现里 diff 可能很大，需要分页或虚拟滚动。
- 悬浮条的「去演示」通过 intent + 路由跳转，不是产品功能，折叠进 throwaway 分支时一并丢弃。
