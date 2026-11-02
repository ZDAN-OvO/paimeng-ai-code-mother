# 实现契约

只写跨模块、没有单一文件拥有的规则：改一处会破坏另一处的那种。接口清单、错误码、字段校验、模型配置细节以代码为准（`src/app/api/[...path]/route.ts`、`src/shared/contracts.ts`、`src/server/business.ts`、`src/server/models/`），不在本文件重复。

## 传输与标识

- 信封 `{code,data,message}`：成功 `code:0` 且 `Cache-Control: no-store`；`BusinessError` 用自己的 code/status；`ZodError` → 400/40000；其他 → 500/50000。收发两端都依赖这个形状，实现在 `src/server/infra/http.ts`。
- 业务 ID 对外一律十进制字符串，库里 BIGINT，主键由 `src/server/infra/snowflake.ts` 发号，不走数据库序列（只有 `generation_step.id` 自增）。
- 生成任务以请求 UUID 为主键，同一 UUID 不重复执行；UI 消息 id 用雪花 ID 或由请求 UUID 派生的确定性 id。

## 权限

- 生成、取消、发布、下载只属于创建者；管理员可编辑/删除他人应用、可读消息与任务，但不能代替创建者执行上述动作。
- 角色每次读数据库当前记录，不信任客户端声明；删除用户时撤销其会话。

## 生成与写入租约

- 输入护轨（`generation/prompt-safety.ts`）在创建 Generation 之前完成，敏感词与注入正则来自 `config/prompt-safety.json`（`PROMPT_SAFETY_RULES_PATH` 可覆盖）。规则文件缺失、JSON 或正则非法一律抛错，不允许退化成空规则放行；新增生成入口必须同样先过 `validatePrompt`。

- harness 是唯一写者，Next 只是 attach 客户端与 SSE 转发：浏览器断连只停止转发，任务在 harness 里照常跑完（ADR-0001、ADR-0003）。
- 平台没有自己的消息表：转录的权威存储在 harness，`GET app/messages` 读回后投影成 UI 消息。
- 每个应用同时只有一个活动任务，状态 `generating` / `building` / `ready` / `failed` / `cancelled`。
- 取消只在模型还在写文件时生效；已进入构建则忽略，构建继续完成。
- 终态与租约释放在同一事务里完成（`generation-store.ts` 的 `finishGeneration`）；租约由每 5 秒一次的心跳发现，失去租约的旧进程不能覆盖新任务。
- 限流计数与任务创建同事务，位置在重复请求与租约检查之后，锁顺序 `app_user` → `app` → `rate_limit`。

## 版本

- 版本历史在平台裸库里（`runtime/versionstore/repos/`），Workspace 没有 `.git`：读写历史一律用 `--git-dir <平台库> --work-tree <目录>`。ADR-0006。
- 提交只走 `versioning/version-store` 的临时索引入口；工作区提交、执行目录提交和发布前构造共用同一套配额（默认 1000 个文件、50 MiB 总量、单文件 10 MiB，`COMMIT_MAX_*` 可配置）。超限不产生 commit、不推 HEAD、不写台账、不改 Workspace。
- 历史只增的 `reference-transaction` 钩子装在平台裸库；只读 git 工具不能执行写子命令。

## 构建、预览与交付

- 服务端拥有验收权：每轮模型结束后先 `buildApp`，诊断能定位到生成源码时交回模型，最多 `BUILD_REPAIR_ROUNDS`（默认 2）轮；源码指纹未变则用原始构建错误收尾，不空转。
- 生成、发布、下载由写入租约互斥。
- `previewUrl` 以实际构建入口是否有效判断，不以任务 ready 为门槛：取消或失败后既有产物仍可预览。
- `sourceAvailable` 独立表示可下载源码；Vue 每次发布都在写锁内重建源码，失败保留旧预览并拒绝本次发布。
- 预览是独立进程、独立主机名（`src/server/delivery/preview.ts`、`scripts/dev/preview.ts`），与平台页面不同源，因此写请求的来源校验必须同时覆盖两侧。

## App runtime 与实时预览

- 运行时容器只能由 `runtime/supervisor` 启停；生成入口、业务层和预览进程都不直接调 Docker。
- 运行时挂载的源码根就是 harness 文件工具写入的执行目录（`generation_execution.directory`）。换基线（新 generation/epoch）时 supervisor 重建容器，旧执行目录不再被任何容器挂载；文件工具的写入准入仍由执行门闩与 Write authority/epoch 决定。
- 每个 App 的 `node_modules` 与全机共享的 pnpm store 是持久目录：容器停止或重建后文件与已安装依赖都还在，重建时按锁文件指纹决定是否重装。
- 容器以 Workspace 属主的宿主 uid 运行，挂载只有自己的 Workspace、自己的 `node_modules` 与共享 store；不注入平台环境变量、凭证或 Docker socket。网络放开。
- 预览：runtime ready 时 `/preview/<类型>_<id>/` 反向代理该 App 的 dev server（HTTP 与 HMR websocket，路径就是预览前缀）；否则回落交付/工作区的静态产物。运行时启动中或失败时返回明确状态页，不透出内部错误。
- 编辑桥接的锁定跟随 Write authority：`app_authority` 处于 active/draining 时预览只读，收束后由宿主页解锁。
