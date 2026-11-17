# Paimeng

AI 生成前端应用的本地平台：用户一句话创建应用，Agent 用文件工具写源码，平台在隔离容器里安装、构建、验证，并通过独立来源预览。

## 项目结构

```text
.
├── AGENTS.md / README.md        # 开发规范 / 启动与使用说明
├── ARCHITECTURE.md              # 模块分层、数据所有权、信任边界
├── GLOSSARY.md                  # 领域术语，命名以此为准
├── docs/adr/                    # 架构决策记录，已定决策只追加不改写
├── docker-compose.yml           # PostgreSQL 16、Redis 7、Nginx
├── docker/
│   ├── nginx/                   # 按 Host 分流主站与预览
│   └── runtime/                 # 生成应用的安装/构建镜像
├── paimeng-ai-code-mother-backend/     # NestJS 11 + Drizzle + Redis + AI SDK
│   ├── src/
│   │   ├── auth/ apps/ conversations/ runs/ preview/ health/   # 接入层：控制器 + service
│   │   ├── agent/               # 一次运行内的模型循环、上下文预算、验证与修复
│   │   ├── tools/               # 模型能力唯一入口：授权、预算、取消、截断
│   │   ├── skills/              # 读取 .paimeng/skills/，只读
│   │   ├── runtime/             # 文件校验、依赖白名单、Docker 调度、应用锁
│   │   ├── startup/             # 单实例锁、遗留运行收尾、容器核对
│   │   ├── common/              # 包络、错误码（api.ts）、截断
│   │   ├── config/env.ts        # 环境变量 zod 校验，唯一读取入口
│   │   ├── db/schema.ts         # 表结构唯一来源
│   │   └── openapi/             # 导出 openapi.json
│   ├── drizzle/                 # 生成的 SQL 迁移，已有文件不改
│   ├── .paimeng/skills/         # 生成技能：static、vue、react
│   ├── openapi.json             # 生成产物：接口契约
│   ├── scripts/                 # 黑盒验收、并发验收、遗留数据清理
│   └── test/
│       ├── *.spec.ts            # Vitest 单测，全部离线
│       └── integration/         # 真实 PostgreSQL / Redis 测试，由 scripts/ci 起一次性服务
├── paimeng-ai-code-mother-frontend/    # Vue 3 + Vite + Ant Design Vue + Pinia
│   ├── src/
│   │   ├── pages/               # 首页、登录注册、AppChatPage（对话+预览）、AppEditPage
│   │   ├── components/          # 通用组件；MarkdownRenderer.vue 唯一渲染模型输出
│   │   ├── api/generated/       # 生成产物：接口函数与类型
│   │   ├── api/streamChat.ts    # 唯一手写接口：流式聊天
│   │   ├── utils/               # 纯逻辑：SSE 解析、队列协调、活动与进度推导
│   │   ├── stores/              # Pinia，只放跨页面状态
│   │   ├── request.ts           # 唯一 axios 实例
│   │   └── config/env.ts        # 前端环境变量唯一读取入口
│   └── test/*.test.ts           # node:test 单测，只测纯逻辑
├── playwright.config.mjs        # 浏览器测试配置；端口与时间预算由 runner 下发
├── scripts/ci/                  # CI 启动器：隔离服务、浏览器服务、脚本语法自检
├── tests/e2e/                   # Playwright 关键流程与固定模型服务
├── tests/ci/                    # CI 启动器自身的离线测试
├── deprecated/                  # 旧实现存档，不改、不引用、不迁移
└── local/                       # 本地草稿，不提交
```

## 一次生成的生命周期

```text
用户发消息
→ conversations/runs 接收，写入 Redis 应用队列（queued；clientRequestId 幂等）
→ 派发器取出 → PostgreSQL 事务创建 run（running；同一应用最多 1 个进行中）
→ agent 模型循环 → tools 调用 runtime 写文件、装依赖、在容器里构建
   ├─ 运行中插话（steer）进收件箱，Agent 消费后 applied，未消费的 returned
   └─ 用户取消 → cancelling
→ 平台验证结果决定终态：completed / failed / cancelled，只写一次
→ 前端经 SSE 收流，断流不算成功；预览走 app-{appId}.preview.<domain>
后端重启：遗留 run 收尾为 failed，队列暂停，不续跑（ADR-0005、ADR-0011）
```

## 红线

- 生成代码不可信：只在隔离容器运行，不挂 Docker socket、不发布宿主端口、无外网/数据库/密钥；后端不执行生成代码。
- 预览独立来源，不与主站互访 DOM、不共享 cookie；预览 iframe 只嵌入不读写。
- 模型和用户内容只经 `MarkdownRenderer.vue` 渲染，保持 `html: false`；不用 `v-html`。
- 修改类接口保留 Origin 校验；接口默认需登录，公开接口显式 `@Public()`；资源查询校验所有者。
- Docker 只操作带 `paimeng.project=paimeng-ai-code-mother` 标签的对象。唯一例外是 `scripts/ci` 创建的一次性测试容器：它们带 `paimeng.ci=<本次运行随机 token>`，只按本次运行的容器名操作，不枚举、不 prune。
- 不得为了过 CI 修改门禁、删除或跳过用例、放宽断言。发现用例不合理就改用例本身并在说明里写明理由。
- 只用 pnpm；后端依赖锁精确版本；新增依赖先确认现有依赖不够用。
- 不读、不打印、不提交 `.env*`（`.env.example` 除外）；新增变量同步 `src/config/env.ts` 和 `.env.example`。
- 不还原、覆盖或格式化与任务无关的文件；未经要求不 commit、不建分支、不 push。
- 改变已定架构决策先新增 ADR，由用户批准。

## 接口契约

接口字段只在后端 zod schema 定义，业务 JSON 统一 `{ code, message, data }`，错误码在 `src/common/api.ts`。改接口后：

```bash
pnpm --filter paimeng-ai-code-mother-backend openapi:export   # 更新 openapi.json
pnpm --filter paimeng-ai-code-mother-frontend openapi         # 更新 src/api/generated/
pnpm contract:check                                           # 确认两者同步
```

生成产物一起提交，不手改。

## 开发约定（oil-dev）

- 快测：`pnpm --filter paimeng-ai-code-mother-backend exec vitest run test/{target}.spec.ts`、`pnpm --filter paimeng-ai-code-mother-frontend exec node --test test/{target}.test.ts`
- 真服务测试：`pnpm test:integration`（真实 PostgreSQL / Redis 与迁移）、`pnpm test:e2e`（Chromium 关键流程，模型用固定响应）、`pnpm test:system`（两者一起，CI 用此入口）。三者都需要本机 Docker；启动器自建一次性容器、临时目录和动态端口，退出时清理，不读写 `.env`。
- 重测：改了 `src/runs/**`、`src/agent/**`、`src/runtime/**`、`src/db/schema.ts`、`drizzle/**` 或消息队列相关代码时跑 `pnpm test:integration`；改了页面交互、SSE、预览或排队状态机时跑 `pnpm test:e2e`。`pnpm --filter paimeng-ai-code-mother-backend test:acceptance`、`test:acceptance:concurrency` 仍需手动跑。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm check:syntax`、`pnpm test`、`pnpm build`、`pnpm contract:check`，合并前再加 `pnpm test:system`。CI 的 `check` 汇总基础检查与系统测试，两者都过才能合并。
- 高风险：`paimeng-ai-code-mother-backend/src/runtime/**`、`paimeng-ai-code-mother-backend/src/agent/**`、`paimeng-ai-code-mother-backend/src/tools/**`、`paimeng-ai-code-mother-backend/src/runs/**`、`paimeng-ai-code-mother-backend/src/auth/**`、`paimeng-ai-code-mother-backend/src/preview/**`、`paimeng-ai-code-mother-backend/src/db/schema.ts`
- 禁改：`paimeng-ai-code-mother-frontend/src/api/generated/`、`paimeng-ai-code-mother-backend/openapi.json`、`paimeng-ai-code-mother-backend/drizzle/`、`deprecated/`
- 频率：编码途中只跑 typecheck；每轮改完跑相关快测；门禁在整批收尾或合并前跑一次；重测在改运行链路时跑，需先启动基础设施和后端，跑不了在交付说明写明。
