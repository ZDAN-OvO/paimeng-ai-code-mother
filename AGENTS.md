# 派蒙 AI 应用工坊：Agent 开发规范

本文件约束在本仓库工作的 AI agent。子目录的 `AGENTS.md` 补充各自规则，冲突时以更深层文件为准。

## 仓库结构

- pnpm workspace（pnpm 10，Node ≥ 22.8），只包含两个包：
  - `paimeng-ai-code-mother-frontend/`：Vue 3 + Vite + Ant Design Vue + Pinia 主站
  - `paimeng-ai-code-mother-backend/`：NestJS 11 + Drizzle（PostgreSQL）+ Redis + Vercel AI SDK
- `docs/api.md`：前后端唯一接口契约。`docs/acceptance.md`：验收记录。
- `PLAN.md`：当前架构与范围决策的来源，改动架构前先读相关章节。
- `deprecated/`：归档的 Java 实现，不参与运行，不要修改、引用或从中迁移代码。
- `local/`：本地私有计划，已通过 `.git/info/exclude` 忽略，不要提交，也不要在公开文档里引用。

## 工作方式

- 只用 pnpm，不要用 npm/yarn 安装依赖，不要生成 `package-lock.json`。
- 新增依赖前先确认现有依赖无法满足。后端依赖锁定精确版本（不加 `^`）。
- 不读取、不打印、不提交 `.env` 及任何 `.env.*`（`.env.example` 除外）。新增环境变量时同步更新后端 `src/config/env.ts` 和根目录 `.env.example`。
- 工作区可能有用户未提交的改动，不要还原、覆盖或格式化与任务无关的文件。
- 未经要求不要 commit、建分支、push。
- 范围以 `PLAN.md` 和 `README.md` 的“当前范围与限制”为准；文档写明首版不做的功能（源码下载、部署分享、可视化编辑、多实例等），不要顺手实现。

## 跨前后端改动

接口变更必须在同一次改动中同步三处：

1. 后端控制器与 zod schema
2. `docs/api.md`
3. 前端 `src/api/*.ts` 与 `src/api/typings.d.ts`（手工维护，不要用 openapi2ts 重新生成覆盖）

所有业务接口使用统一包络 `{ code, message, data }`，错误码表以 `docs/api.md` 为准。新增错误码需同时更新后端 `src/common/api.ts` 和文档。

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
