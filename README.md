# Paimeng

AI 生成前端应用的本地平台：用户用一句中文描述创建应用，主 Agent 通过文件工具写入源码，平台负责受控依赖安装、构建验证与实时预览。

- 前端：Vue 3 + Vite + Ant Design Vue + Pinia（`paimeng-ai-code-mother-frontend/`）
- 后端：NestJS 11 + Drizzle（PostgreSQL）+ Redis + Vercel AI SDK（`paimeng-ai-code-mother-backend/`）
- 生成的应用：静态 HTML/CSS/JS 或 Vue/React + Vite；安装、检查、构建与开发服务器使用隔离 Docker 容器，静态页面由预览网关提供
- 生成技能：后端根目录 `.paimeng/skills/`（`static`、`vue`、`react`）

## 核心功能

- 注册登录，创建、查看、改名和删除自己的应用。
- 连续对话生成与修改，支持普通消息排队、运行中插话和主动停止。
- 查看生成回复、计划、源码变更与平台验证结果，实时预览当前应用。

## 环境要求

- Node.js ≥ 22.8（推荐 24）
- pnpm 10
- Docker 24+ 与 Docker Compose v2
- 可访问的 OpenAI Responses 兼容模型网关（默认 `http://127.0.0.1:3425/v1`）
- Linux 主机（依赖 Docker、`/proc/meminfo`、`df` 与本机网络）

## 启动

1. 配置环境变量：

```bash
cp .env.example .env
# 至少修改 SESSION_SECRET，并按需填写 AI_BASE_URL / AI_KEY / AI_MODEL / AI_CONTEXT_WINDOW_TOKENS
```

后端从 `paimeng-ai-code-mother-backend/.env` 读取配置；不存在时会回退到仓库根 `.env`。

2. 启动 PostgreSQL、Redis、Nginx：

```bash
docker compose up -d
```

3. 安装依赖并构建前端与后端：

```bash
pnpm install
pnpm build
```

4. 初始化数据库：

```bash
pnpm --filter paimeng-ai-code-mother-backend db:migrate
```

5. 启动后端（构建型应用的运行时镜像会在首次需要时构建；也可设 `SETUP_IMAGE_ON_START=true` 在启动时构建）：

```bash
pnpm dev:backend
```

6. 打开 `http://paimeng.localhost:8080`（若修改了 `NGINX_PORT`，使用对应端口）。

前端开发模式：`pnpm dev:frontend`，Vite 在 `http://localhost:5173`，`/api` 代理到 `127.0.0.1:8123`。

## 端口与域名

| 用途 | 地址 |
| ---- | ---- |
| 主站（Nginx） | `http://paimeng.localhost:8080` |
| 预览 | `http://app-{appId}.preview.paimeng.localhost:8080` |
| 后端 | `http://127.0.0.1:8123/api` |
| PostgreSQL | `127.0.0.1:5433` |
| Redis | `127.0.0.1:6380` |

`paimeng.localhost` 与 `*.preview.paimeng.localhost` 在 Linux 上通常自动解析到 `127.0.0.1`/`::1`。若无法解析，可在 `/etc/hosts` 增加：

```
127.0.0.1 paimeng.localhost app-1.preview.paimeng.localhost
```

模块依赖和隔离边界见[架构](ARCHITECTURE.md)。

## 检查

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm contract:check
```

push 到 `main` 和 pull request 会在 GitHub Actions 上自动跑这组检查。另一个并行任务执行真实 PostgreSQL、Redis 集成测试和 Chromium 浏览器测试。`check` 汇总两个任务，只有两者都成功才通过；`main` 的合并规则要求 `check` 通过，且分支包含最新主干。管理员仍可使用仓库原有的绕过权限。

### 运行集成测试与浏览器测试

先安装依赖和 Chromium：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

需要本机 Docker 可用。按改动范围选择一个命令：

```bash
pnpm test:integration  # 真实 PostgreSQL、Redis 与迁移
pnpm test:e2e          # Chromium 中的关键操作流程
pnpm test:system       # 两者一起运行，CI 使用此入口
```

启动器自动构建所需产物，创建独立的 PostgreSQL、Redis 容器和临时运行目录，并在退出时清理本次创建的资源。测试不加载 `.env`，不连接开发数据库，也不让浏览器测试的后端访问 Docker。浏览器测试只替换模型响应，鉴权、消息队列、SSE、文件写入和静态预览仍走真实后端。

PR 测试使用构建后的前端和测试代理，不覆盖生产 Nginx、真实模型或应用容器构建。失败时 GitHub Actions 保留浏览器截图与 trace 三天。

CI 的模型响应全部来自本地测试服务，不调用真实模型，也不需要网关地址或 API Key。需要真实模型的黑盒验收在本机手动执行，不纳入 CI；生成应用的 Docker 构建与容器预览仍需单独验收。

OpenAPI 页面在 `http://127.0.0.1:8123/api/v3/api-docs`。

### 黑盒验收

先完成上述启动步骤，确保后端、Nginx、PostgreSQL、Redis 和模型网关可用。在仓库根目录运行：

```bash
ACCEPTANCE_MAIN=http://paimeng.localhost:8080 ACCEPTANCE_PREVIEW_PORT=8080 pnpm --filter paimeng-ai-code-mother-backend test:acceptance
ACCEPTANCE_MAIN=http://paimeng.localhost:8080 pnpm --filter paimeng-ai-code-mother-backend test:acceptance:concurrency
```

示例使用主站端口 8080；若修改了 `NGINX_PORT`，同步修改这两个验收变量。脚本会创建测试账号和应用、触发真实模型运行并取消。它们不覆盖完整生成构建链路、浏览器 iframe 和 WebSocket。

## 当前范围与限制

平台面向单机、单后端实例的前端应用生成与连续修改。生成应用使用受控依赖，在隔离环境验证并通过独立来源预览；后端重启不续跑。

运行与资源上限在 `.env.example` 中配置（如 `TASK_MEMORY_MB`），依赖白名单与 registry 中继见 [ADR-0007](docs/adr/0007-dependency-allowlist-and-registry-relay.md)。
