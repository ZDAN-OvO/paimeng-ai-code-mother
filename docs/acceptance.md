# 验收记录

日期：2026-11-12；复验：2026-11-13（Asia/Shanghai）

## 自动化检查

后端：

```bash
cd paimeng-ai-code-mother-backend
npx tsc -p tsconfig.json --noEmit
npx eslint "src/**/*.ts" "test/**/*.ts"
npx vitest run
npx tsc -p tsconfig.build.json
```

结果：类型检查、ESLint、52 个单元测试（16 个文件）、构建全部通过。单元测试覆盖上下文预算、运行 100 步/30 分钟边界、5m/3m/60s 超时配置、任务/预览超时后的终止与容器移除、Docker CLI 超时终止、文件路径/大小/数量/源码总量配额、50 KiB 读取截断、依赖策略、依赖目录失败恢复、密码哈希、技能 frontmatter、预览空闲回收策略、阶段取消、SSE 断流处理、消息内容块、工具输出截断和日志保留上限。

阶段取消使用可控 Docker CLI 替身验证控制流与时限：`test/cancellation.spec.ts` 覆盖文件工具写入/编辑/删除取消后无副作用，安装、构建、预览启动容器在取消后 5 秒内停止并移除，以及 SSE 断流触发 `cancelRun`、正常 `run-finished` 关闭不触发取消。

前端：

```bash
cd paimeng-ai-code-mother-frontend
npx vue-tsc --build
npx eslint .
npm test
npx vite build
```

结果：类型检查、ESLint、8 个前端单测、生产构建全部通过。`test/sse.test.ts` 覆盖 CRLF、跨分片事件、UTF-8 多字节拆分、多行 `data`、注释心跳和无结尾空行的收尾块；`test/chat-message.test.ts` 覆盖历史重载时从内容块恢复文本、工具摘要和验证摘要；`test/preview-auth.test.ts` 覆盖预览 cookie 每 5 分钟续期的边界、隐藏状态和无预览时不续期。

技能：

```bash
python3 /home/zdan/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  paimeng-ai-code-mother-backend/.paimeng/skills/static
# vue、react 同样执行
```

结果：三个技能均为 `Skill is valid!`。

## 黑盒 API 验收

要求后端、Nginx、PostgreSQL、Redis 已启动：

```bash
cd paimeng-ai-code-mother-backend
npm run test:acceptance
```

覆盖注册、未登录 401、登录态、应用创建/列表/详情/改名、历史、越权访问 403、运行不存在 404、预览票据 POST、票据单次使用、未授权预览 401、删除应用、退出登录。最近一次结果：

```text
验收通过：账号 acceptance1794503496703，应用 155
```

并发与防重：

```bash
cd paimeng-ai-code-mother-backend
npm run test:acceptance:concurrency
```

覆盖同应用 20 个并发请求只产生一个 run、运行中删除返回 409、`clientRequestId` 重复请求只指向同一个 run、首次 SSE 事件丢失后按 `appId + clientRequestId` 查询到原 run、应用分钟限流返回 429、单用户 6 个应用同时申请时最多接受 5 个。另验证应用 `23` 被限流时应用 `89` 仍能启动运行，限流按应用隔离。最近一次结果：

```text
并发验收通过：单 run、防重、限流、单用户 5 应用上限

2026-11-13 使用最新构建产物重启后复验：`/api/health/ready` 返回 PostgreSQL、Redis、运行时镜像均 `ok`；主站经 Nginx 返回 200；上述两项黑盒验收再次通过。未授权顶层预览请求返回 302 并指向 `http://paimeng.localhost:8090/app/chat/135`，资源请求仍返回 401。
```

## 真实模型四轮验收

使用真实网关 `http://127.0.0.1:3425/v1`、模型 `auto/deepseek-v4.1-flash`。

| 轮次 | runId | 结果 | 证据 |
| --- | --- | --- | --- |
| 静态生成 | `aec208f1-3aad-4222-bdab-a95b331a4811` | completed | `runtime/output_code/23/` 下 `index.html`、`styles.css`、`app.js` |
| 静态修改 | `4c27b4c1-a9ce-4541-81a2-71e13cb6ddf6` | completed | 预览标题改为“我的待办清单” |
| 切换 Vue | `d6677bbe-03ab-4a9d-9251-a2d874a7e93c` | completed | `runtime/logs/23/typecheck-2026-11-12T14-30-15-740Z.log`、`build-2026-11-12T14-30-17-638Z.log` |
| 切回静态 | `8694f2fd-36e6-483a-82ed-b43d5fe7caa5` | completed | `runtime/deps/23`、`runtime/build/23` 已清理，静态预览恢复 |

断流取消验证：`48334cf2-6c22-4d8a-9a71-877dffebe5bf`，状态进入 `cancelled`，已产生的文本和工具记录保留。

消息内容块复验（2026-11-13）：新建应用 `135`，真实模型运行 `c7992225-11c3-4c95-9a64-91de824fece8` 状态 `completed`；`GET /api/chatHistory/app/135` 中 assistant 消息为 `parts = [text, tool-summary × 5, validation-summary]`，工具摘要状态为 `completed`、验证摘要为 `passed`，文本 1156 字节。首次工具为 `load_skill`，其余为文件工具。

取消后继续复验（2026-11-13）：应用 `135` 的取消轮 `67953c8b-5ee6-4863-ba24-f6f2dc806b6f` 终态 `cancelled`，assistant 内容保留文本和 3 个 `read` 工具摘要；随后运行 `5b1a666a-d3be-4cff-a0b3-ceb52768013d` 实际调用 `read` 和 `edit`，终态 `completed`、验证 `passed`，磁盘 `index.html` 标题已变为“继续验证”。复验后数据库中 `streaming` assistant 与 `running/cancelling` run 均为 0。

浏览器侧使用无头 Chrome + CDP 验证：主站应用页正常加载；预览 iframe 的 URL 不包含票据；隐藏授权 frame 完成 POST 后，预览页显示“我的待办清单”。

崩溃恢复验证：在运行 `e5bb4014-d81b-4b3d-a491-3123a2a98e55` 生成期间对后端执行 `kill -9`，重启后该运行进入 `failed`、`errorCode=INTERRUPTED`；assistant 消息不再是 `streaming`，执行记录中的工具调用均有对应结果，没有自动续跑模型。

崩溃文本保留复验（2026-11-13）：运行 `15e21eed-de21-4f18-9a8c-3d1e5e2777c7` 流式输出 431 字节后对后端 `kill -9`；杀进程前后台 assistant 内容已包含部分正文，重启后运行进入 `failed`、`errorCode=INTERRUPTED`，正文保留并追加“运行因后端重启中断，未自动续跑”标记，没有重新发起模型请求。

删除失败重试：临时将 `runtime/output_code` 设为不可写后删除应用 `57`，应用进入 `deleting`、`delete_attempts=1`；恢复权限后自动重试并删除成功。删除应用 `58` 时再次制造失败并 `kill -9` 后端，重启日志显示“恢复 1 个待删除应用”，随后该应用被删除。

删除重试复验（2026-11-13）：应用 `136` 的源码目录设为不可写后删除，数据库记录 `status=deleting`、`delete_attempts=2`、错误为 `EACCES`、已写入下次重试时间；恢复权限后自动重试成功，源码目录、对话与运行记录计数均为 0。

重启恢复复验（2026-11-13）：应用 `137` 制造删除失败后对后端 `kill -9`，重启日志出现“恢复 1 个待删除应用”；恢复目录权限后按第 3 次重试的 120 秒策略自动完成删除，最终源码目录不存在，对话与运行记录计数均为 0。

Vue HMR WebSocket：复用 Vue 测试项目创建应用 `89` 并启动预览。无头 Chrome + CDP 观察到 `ws://app-89.preview.paimeng.localhost:8090/?token=...` 建立；调用退出登录后，该 WebSocket 被关闭，预览授权同时撤销。

WS 授权过期：临时将 `PREVIEW_AUTH_TTL_MS` 设为 `10000`，建立 HMR WebSocket 后等待授权过期，清理周期内连接被关闭；验证后已恢复默认配置。

预览授权续期：前端每 60 秒检查一次可见预览，超过 5 分钟时重新申请票据并通过隐藏授权 frame 写入新 cookie；续期只更新授权，不修改当前 iframe 的 `src`，避免刷新用户正在查看的页面。

前端 403：使用无权用户打开应用 `23`，页面回到 `/` 并显示主页内容，没有停留在越权应用页。

前端 429：预先填满应用 `23` 的限流窗口后在页面发送消息，页面显示后端返回的“请求过于频繁”原因。

前端 409：页面加载后先用另一个请求占用应用 `23` 的运行，再从页面发送消息，页面显示“应用已有运行中的任务”。

预览空闲回收：临时将 `PREVIEW_IDLE_MS` 设为 `1000` 后启动应用 `89` 的 Vue 预览，30 秒清理周期内容器被移除，状态变为 `stopped`，后端日志出现“回收空闲预览 89”；验证后已恢复默认配置。

预览空闲回收复验（2026-11-13）：临时将 `PREVIEW_IDLE_MS` 设为 `5000`，应用 `89` 预览启动后日志分别在 `00:20:36`、`00:21:36` 出现“回收空闲预览 89”，`docker ps` 已无 `paimeng.app=89` 容器；随后已用默认配置重启后端。

上下文预算拒绝：临时将 `AI_CONTEXT_WINDOW_TOKENS` / `AI_OUTPUT_RESERVE_TOKENS` 设为 `100` / `10`，运行 `cae3812c-f661-4ea0-9207-7c2485a5a3e1` 在模型调用前进入 `failed`、`errorCode=CONTEXT_BUDGET_EXCEEDED`、`stepCount=0`；验证后已恢复默认配置。

主页自动启动与停止回归（2026-11-13）：从主页输入提示词创建应用 `177`，页面跳转后立即发起 `POST /api/app/chat/gen/code` 并出现流式文本和工具活动；运行中点击“停止生成”，运行终态为 `cancelled`（`b8b7f0b7-bbec-43ab-9ac4-cb1598000094`），已产生的用户消息、助手文本和“已停止”状态保留。刷新页面后历史仍可恢复，未再出现“加载对话失败”。工具活动默认显示为一行折叠摘要，展开后显示 `load_skill`、`ls` 等具体调用。此次同时修复了停止时 SSE 收尾与取消请求并发触发重复历史刷新，以及历史接口偶发 400 时的一次自动重试。

## 目标版本验证

通过 `npx --offline -y -p node@24 -p pnpm@10.14.0` 并设置 `npm_config_manage_package_manager_versions=false`，临时提供 Node `24.22.3` / pnpm `10.14.0`：

- 后端 `tsc`、52 个单元测试、生产构建通过。
- 前端 `vue-tsc`、8 个前端单测、生产构建通过。
- 使用 pnpm 10 重建单文档锁文件后，`pnpm install --frozen-lockfile` 成功；重装依赖后再次执行上述类型检查、测试与构建仍全部通过。

当前宿主为 Node `26.13.0` / pnpm `12.14.0`；根 `packageManager` 已固定为 `pnpm@10.14.0`，由 pnpm 自动切换。

## UIMessage 顺序改造验收（2026-11-14）

- 后端 `agent_session_entries` 仍按 `seq` 保存模型执行上下文；`messages.content` 改为 Vercel AI SDK `UIMessage`。
- 助手 parts 按实际发生顺序保存：文本、dynamic-tool、计划修订和验证状态。工具完成只更新原位置。
- 前端使用 `ai@6.0.330` 的 `DefaultChatTransport` 与 `readUIMessageStream`，折叠只合并连续同类工具。
- 旧应用及消息在切换时清理，用户账号和配置保留。

### 自动化检查

- 后端：`tsc`、ESLint、23 个测试文件共 85 项测试、生产构建全部通过。
- 前端：`vue-tsc`、ESLint、35 项 Node 测试、Vite 生产构建全部通过。
- 根级 `pnpm` 10.14.0 在当前 Node 26 环境中由全局 pnpm 11 触发版本下载，受离线网络限制无法启动；使用各包实际锁定的本地二进制执行了与根脚本等价的 typecheck、lint、test、build。

### 黑盒与浏览器验收

- 旧应用清理：删除 172 个应用，保留 62 个账号；源码、依赖、构建、日志和项目容器核验无残留。
- 维护清理固定清单：先运行 `tsx scripts/purge-legacy-apps.ts --manifest <path>` 预览并写入清单，停止后端后使用 `--execute --manifest <path>`；执行期间使用 Redis 维护锁，只处理清单内应用。
- API 验收：账号 `acceptance1794636723514`，应用 `199`，通过。
- 并发验收：单 run、防重、限流、单用户 5 应用上限通过。
- 真实模型：应用 `209`，首轮 run `de48fc15-1c92-4986-9980-4e8818b90fe5` 完成，parts 为 `dynamic-tool,dynamic-tool,data-plan,dynamic-tool,dynamic-tool,dynamic-tool,data-plan,data-plan,text,data-validation×7`。
- 实时打断：run `596b3eb1-8ad5-4e82-9bf9-39f550a8a086` 取消后保留已发生 parts；新要求 run `3da41686-f567-44df-9ec6-dbcc3d65c7e1` 完成，顺序为计划、工具、计划、文字、验证。
- 浏览器刷新后顺序与落库一致；连续同类工具形成独立折叠组，计划修订和后续文字保持原位置。

## 剩余限制

- 阶段取消的自动化测试使用可控 Docker CLI 替身验证控制流与 5 秒时限；模型流取消和断流已在真实网关上跑通，文件工具、安装、构建、预览启动四阶段未再逐一用真实容器重复执行。真实 Nginx 流已覆盖正常 SSE 传输。
- 真实模型四轮验收与浏览器验收是一次性验收记录，未纳入 CI。
- 单机单实例部署，不支持多副本或跨机调度；每个用户最多 5 个应用同时运行，整机最多 5 个活跃预览。
- 本地数据库保留验收账号 `skilltest1794492990`（应用 `23`、`89`）、`parts1794500123063`（应用 `135`），以及 `acceptance*` / `concurrency*` / `delretry*` / `delrestart*` 临时账号，仅用于复现验收，不属于产品数据。

> 2026-11-14 UIMessage 改造切换时已清理本地环境全部旧应用，账号保留；上列旧应用 ID 不再存在。

## 运行详情与工作台改造验收（2026-11-13）

本轮新增结构化计划、公开活动、文件快照、diff、验证日志和详情配额，前端改为预览优先工作台。以下为本次实际执行记录。

### 自动化检查

```bash
cd paimeng-ai-code-mother-backend
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/eslint "src/**/*.ts" "test/**/*.ts"
node_modules/.bin/vitest run
node_modules/.bin/tsc -p tsconfig.build.json

cd ../paimeng-ai-code-mother-frontend
node_modules/.bin/vue-tsc --build
node_modules/.bin/eslint src
node --test --test-isolation=none test/*.test.ts
node_modules/.bin/vite build
```

结果：后端类型检查、ESLint、52 个单测、生产构建通过；前端 `vue-tsc`、ESLint、11 个单测、生产构建通过。新增前端单测覆盖分栏默认宽度、320–560 边界、预览最小 480px 和损坏的 `localStorage` 回退。

## 无代码回合与首页布局修复（2026-11-13）

问题：应用 `184` 的运行只有 `load_skill`、`ls` 和 `update_plan`，没有写入任何文件，却在模型文本回合后进入平台验证，连续 4 次报“项目目录没有任何源文件”并以 `VALIDATION_FAILED` 结束。

修复：

- 文件工具在成功写入、编辑或删除后标记本轮源码变更；只有存在变更时才进入安装、类型检查、构建和预览验证。
- 无变更回合先追加一次系统提示要求实际调用文件工具；再次无变更时以 `NO_CODE_PRODUCED` 结束，不再消耗修复次数。
- 已有代码但验证失败后没有产生新的修复变更时，以 `VALIDATION_FAILED` 结束，避免与“从未生成代码”混淆。
- 首页始终保留大标题、大输入框和示例提示，最近应用固定显示在下方。

验证：后端 `tsc`、ESLint、57 个 Vitest、生产构建通过；前端 `vue-tsc`、ESLint、15 个单测、生产构建通过。真实模型回归运行 `21eadcc0-8d7a-4ed5-bf7b-ce407dd5253d`（应用 `185`）先执行 3 次 `write`，随后才出现 `validation-status`，终态 `completed`、`changes.filesChanged=3`。在原先失败的应用 `184` 重试运行 `a3fcfc6f-309e-4a5b-bf56-42af85cc6c4b`，模型连续两个回合只返回空内容、没有调用文件工具；运行以 `NO_CODE_PRODUCED` 结束，`stepCount=2`，全程没有产生 `validation-status`，也不再出现 4 轮源码检查。重启后 `/api/health/ready` 的 PostgreSQL、Redis、运行时镜像均为 `ok`；主站首页刷新后可见“把一句话，变成能用的应用”大创作区和下方最近应用列表。

## Codex 风格消息折叠（2026-11-13）

调研方式：直接读取本机 Codex 桌面端 `/usr/lib/chatgpt/resources/app.asar` 的前端产物，定位 `localConversation.workedFor`、`localConversation.workingFor` 和 `agentActivity` 相关实现。

调研结论：

- 第一级是整轮折叠。运行中显示“已处理 X”，结束后显示“用时 X”，整轮正文和活动默认收起。
- 第二级是同类操作合并。Codex 按 `exec`、`patch`、`web-search` 等类别在整轮内分组，而不是只合并相邻操作；读取、编辑交错出现时仍只有一个“已读取文件”组和一个“编辑了文件”组。
- 分组行本身可折叠，展开后才是每个具体文件或调用；同一工具连续调用还会显示调用次数。
- 最终回复正文和活动记录是同一轮里的内容，活动组不应再单独铺成“执行记录 · N 条”的大面板。

实现：

- 助手消息移除“派蒙”消息头，改为整轮折叠行；完成后显示“用时 X”，运行中显示“已处理 X”。
- 按读取、编辑、加载工具、依赖等类别合并整轮操作，同类组默认收起；展开后显示具体文件与搜索内容。
- 平台验证改为一行可展开摘要，默认收起；计划、文件变更保持紧凑行。
- 新增 `src/utils/agentActivity.ts` 纯函数与 4 个前端单测，锁定“整轮同类合并、首次出现顺序、部分失败不污染整组、标签映射”规则。

浏览器验证：应用 `186` 的完成轮折叠为“用时 7 分 17 秒”；展开后显示“加载了工具”“已读取文件”“编辑了文件”三个组，展开“已读取文件”后可见 `已查看项目目录`、`已读取 styles.css`、`已读取 index.html` 和搜索记录。前端 `vue-tsc`、ESLint、15 个单测、生产构建通过。

数据库迁移 `drizzle/0001_flawless_magdalene.sql` 已在本地 PostgreSQL 执行成功。使用临时应用和临时源码目录做了一次快照集成校验：原文件 `<h1>A</h1>` 改为 `<h1>B</h1>` 并新增一行，返回 `filesChanged: 1, additions: 2, deletions: 1`；计划 `revision: 1`；校验后已删除临时应用和源码目录。

### 真实运行

- 取消轮 `c7ce77c8-0afe-488e-96af-d04c16218763`：SSE 断开触发取消，终态 `cancelled`，`detailsStatus=ready`；计划 5 步、`index.html` 为新增文件，记录 `additions: 82`。
- 完成轮 `77431cfa-1eda-4dd5-b5b8-6eaddac9d16a`：终态 `completed`，`detailsStatus=ready`，`detailsError=null`；计划修订到第 3 版、6 个步骤全部标记完成；验证记录包含源码/清单/安装/类型检查/构建/预览六项，静态项目正确显示“跳过”；净变更 3 个文件、`+639 −2`。
- Vue 完成轮 `fa6b61e5-5432-4882-97d8-94ef1316e242`：终态 `completed`，`detailsStatus=ready`；计划修订到第 5 版、4 个步骤全部完成；源码/清单/安装依赖/类型检查/构建/预览六项全部 `passed`；净变更 8 个文件、`+306 −0`。通过 Nginx 票据授权后，`app-182.preview.paimeng.localhost:8090` 返回 Vite 页面 HTML，确认框架构建与预览链路可用。
- Vue 修改轮 `be4d4090-b645-446b-af62-b257db480adf`：终态 `completed`，计划 2 步全部完成，六项验证全部 `passed`；净变更 2 个文件、`+2 −2`，分别是 `index.html` 和 `src/App.vue` 的标题修改，说明同项目增量基线没有串轮。
- React 完成轮 `7de73993-224f-4340-87df-1c2720c9d5e5`：终态 `completed`，`detailsStatus=ready`；源码/清单/安装依赖/类型检查/构建/预览六项全部 `passed`；净变更 8 个文件、`+323 −0`；预览状态为 `running`、类型 `react`。
- 详情接口核对：完成轮的 `index.html` diff 为 `+2 −2`（标题修改），新增轮为 `+82 −0`；两轮独立，未出现历史串轮。

### 浏览器检查

使用无头 Chrome 带本地登录态访问 `/app/chat/181`，截图覆盖 390、768、1024、1440px：

- `1024px` 及以上为左右分栏，左栏 340/400px 默认宽度，右侧预览占主舞台。
- `1023px` 以下切换为“对话 / 预览”Tab，输入框和计划/变更/验证卡可用，无页面横向溢出。
- 完成轮页面正确显示计划卡、`+639 −2` 变更卡、六项验证结果和“执行记录 · 计划 6/6”。
- 变更抽屉可列出 `index.html`、`app.js`、`styles.css`，diff 抽屉显示语法化行与 `+/-` 背景。

### 生产域名预览验收

- 直接打开 `http://127.0.0.1:5173` 时 iframe 被预览页 CSP `frame-ancestors` 拒绝，这是开发来源与生产来源不同导致的预期行为，不是预览页面本身失败。
- 使用主机映射 `paimeng.localhost` / `app-181.preview.paimeng.localhost → 127.0.0.1` 打开 `http://paimeng.localhost:8090/app/chat/181`，预览 iframe 成功加载生成页，页面标题为“我的待办清单”，输入框、筛选和空状态均可见；主站工作台同时显示计划、变更和验证卡。
- Vue 应用 `182` 的预览 iframe 成功渲染“极简计数器”，数字、加减按钮、重置按钮和最近变化区域可见；Vue 生成轮的计划卡在完成后自动折叠为摘要。
- 通过 Nginx `8090` 使用 `Host: app-181.preview.paimeng.localhost` 走完票据 POST、`pm_preview` cookie 和页面 GET，返回 204 后页面 GET 为 200，`Content-Type: text/html`，标题为“我的待办清单”。

### 本次未完成的环境验证

- 本轮真实模型覆盖静态、Vue 和 React 应用；未重复执行“静态 ↔ Vue ↔ React”连续切换场景，既有历史验收记录仍可作为该路径的补充证据。

## 生成中打断、内部字段隐藏与模型缓慢排查（2026-11-14）

应用 `187` 的续跑 `3e744b07-faf6-4772-87e7-cf152145e1d4` 有 9 次 `write` 参数为 JSON 中途截断的字符串，均被旧实现按“expected object, received string”返回模型。它们分别消耗约 50–99 秒，累计约 9.5 分钟；对应工具处理仅数毫秒。输出预算为 8192 tokens，截断长度反复接近同一范围，与输出上限导致的截断一致。旧实现没有记录 finishReason/usage，不能从旧数据断言网关当时的全部内部状态。旧前端只呈现文字 delta，生成工具参数的时间没有可见进度。

本轮修复：

- 消费 AI SDK 的 fullStream，保留 finishReason、invalid 工具标记与 usage；流内错误立即失败并 abort 上游，不再进入无代码重试。
- 无效工具参数不执行落盘；提示拆分模块和缩短参数，在无成功文件变更期间累计 3 次异常即停止，避免只读调用重置失败预算。
- 历史无效调用转换为简短失败说明；原始 DB 审计仍保留，有效工具与用户历史保留。取消或出错前的文字也保留。
- 新增 model-status，记录首内容事件耗时、请求总耗时、工具参数字节数及网关 usage。前端只展示“正在编写文件／修改文件 · 已接收 X KB”等进度。
- 运行中输入框可编辑，“打断并发送”先取消旧轮，确认终态、旧流和历史收尾后才启动新请求；失败时保留待发消息。刷新恢复中的运行也可以打断。
- 从主页卡片、工作台、应用详情和编辑页移除页面类型展示；codeGenType 仅保留接口内部字段。

验证结果：

- 后端类型检查、ESLint、82 项单测、生产构建通过；前端类型检查、ESLint、29 项单测、生产构建通过。
- 使用真实 OpenAI Responses adapter 和可控 SSE 响应，验证截断 JSON、usage、流内错误；Agent 测试覆盖异常调用不落盘、只读间隔不重置限额、取消和流错误保留文字。
- API 黑盒验收通过（应用 `188`，脚本已清理）；并发黑盒验收通过同应用单 run、防重、限流和单用户 5 应用上限。
- 独立验收账号应用 `189`：`b93ec23c-c36b-44ff-a2e6-0a0edec1f4b0` 在工具参数流开始后取消，3318ms 进入 cancelled。新轮 `539f4353-d8e7-43ac-93f9-32c9bdbe2719` 在 23852ms 完成一个简短可交互待办页面，5 个模型回合均无 invalid 调用；首内容事件约 1.4–4.1 秒，写文件回合接收 3125 字节参数、输出 1037 tokens。这个小任务的耗时不代表完整博客的性能指标。
- 使用实际前端 chatCoordinator 对接真实 API（同一独立验收账号），旧轮 `d2302f87-93ac-4071-bdbb-c9bc1e522b6d` cancelled 后才启动新轮 `b03381a2-c6ee-4c39-ab63-7c811cab2eb5`，后者 completed；两个 clientRequestId 不同，无重叠运行、无409、无丢消息。
- 浏览器只读确认主站卡片、应用 `187` 工作台与详情不再展示页面类型。自动审批拒绝了在用户当前账号新建验收应用，因此未进行该账号下的浏览器发送操作；交互控制由协调器测试和独立账号真实 API 联调验证。
- 本轮触及的后端文件 Prettier 检查通过。全包 format:check 仍有 20 个既有文件未通过，未做无关格式化。
