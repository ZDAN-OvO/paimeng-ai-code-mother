# Paimeng：Agent 开发规范

本文件约束在本仓库工作的 AI agent。子目录的 `AGENTS.md` 补充各自规则，冲突时以更深层文件为准。

## 仓库结构

pnpm workspace（pnpm 10，Node ≥ 22.8），只包含前端和后端两个包：

```text
.
├── paimeng-ai-code-mother-frontend/   # 主站：Vue 3 + Vite + Ant Design Vue + Pinia
├── paimeng-ai-code-mother-backend/    # 后端：NestJS 11 + Drizzle（PostgreSQL）+ Redis + Vercel AI SDK
│   └── openapi.json                    # 由 zod schema 导出的接口契约，前后端共用
├── docs/
│   ├── DESIGN.md                      # 系统设计：架构、边界、约束与接口契约
│   └── adr/                           # 架构决策记录
├── docker/
│   ├── nginx/                         # 主站与预览来源的 Nginx 配置模板
│   └── runtime/                       # 生成应用的运行时镜像
├── image/                             # README 配图
├── deprecated/                        # 归档的 Java 实现，不参与运行
├── local/                             # 本地私有计划，已被 .git/info/exclude 忽略
├── GLOSSARY.md                        # 领域术语表
├── README.md
├── docker-compose.yml                 # PostgreSQL、Redis、Nginx
├── .env.example
└── pnpm-workspace.yaml
```

- 改动架构、模块边界或安全边界前，先读 `docs/DESIGN.md` 和相关 ADR；推翻已有决策时新增一条 ADR 并标记旧记录被取代。
- 讨论或命名领域概念时以 `GLOSSARY.md` 为准，新概念确定后同步补充。
- 单次任务用的临时计划文档（如根目录 `PLAN.md`）不提交，其他文档不要引用。
- `deprecated/` 不要修改、引用或从中迁移代码。
- `local/` 不要提交，也不要在公开文档里引用。

## 工作方式

- 只用 pnpm，不要用 npm/yarn 安装依赖，不要生成 `package-lock.json`。
- 新增依赖前先确认现有依赖无法满足。后端依赖锁定精确版本（不加 `^`）。
- 不读取、不打印、不提交 `.env` 及任何 `.env.*`（`.env.example` 除外）。新增环境变量时同步更新后端 `src/config/env.ts` 和根目录 `.env.example`。
- 工作区可能有用户未提交的改动，不要还原、覆盖或格式化与任务无关的文件。
- 未经要求不要 commit、建分支、push。
- 范围以 `docs/DESIGN.md` 的“范围边界”和 `README.md` 的“当前范围与限制”为准；文档写明首版不做的功能（源码下载、部署分享、可视化编辑、多实例等），不要顺手实现。

## 跨前后端改动

接口字段只在后端 zod schema 中定义，然后重新生成契约产物：

1. 修改后端控制器与 zod schema，运行 `pnpm --filter paimeng-ai-code-mother-backend openapi:export`
2. 运行 `pnpm --filter paimeng-ai-code-mother-frontend openapi`
3. 运行 `pnpm contract:check`，确认 `openapi.json` 与 `src/api/generated/` 已同步

`paimeng-ai-code-mother-backend/openapi.json` 和前端 `src/api/generated/` 都是生成产物，要一起提交，但不要手改。前端普通接口一律调用生成函数；只有流式聊天（`src/api/streamChat.ts`）保留手写。

所有业务接口使用统一包络 `{ code, message, data }`，错误码表以 `docs/DESIGN.md` 为准。新增错误码需同时更新后端 `src/common/api.ts` 和该表。

## 安全边界（不可违反）

- 生成的应用运行在隔离 Docker 容器中：不挂载 Docker socket，不发布宿主机端口，只允许白名单依赖，不提供外网、数据库或密钥。
- 预览使用独立来源 `app-{appId}.preview.<domain>`，不要让主站与预览 iframe 互相访问 DOM 或共享 cookie。
- 聊天 Markdown 渲染保持 `html: false`。
- 修改类接口保留 Origin 校验；新接口默认需要登录，公开接口必须显式使用 `@Public()`。
- 应用、会话、运行等资源查询必须校验所有者。
- Docker 资源只操作带 `paimeng.project=paimeng-ai-code-mother` 标签的对象。

## 验证

提交结果前，在仓库根目录按改动范围运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

只改一个包时可用 `pnpm --filter <包名> <脚本>` 缩小范围。涉及运行链路（生成、安装、构建、预览、取消、并发）时，在基础设施和后端已启动的前提下补跑 `paimeng-ai-code-mother-backend` 的 `test:acceptance` / `test:acceptance:concurrency`，无法运行时在交付说明里写明。

交付说明写清楚：改了什么、为什么、跑了哪些检查及结果、哪些没验证。
