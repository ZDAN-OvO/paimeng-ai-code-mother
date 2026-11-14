# 派蒙 AI 应用工坊

AI 生成前端应用的本地平台：用户用一句中文描述创建应用，主 Agent 通过文件工具写入源码，平台负责受控依赖安装、构建验证与实时预览。

- 前端：Vue 3 + Vite + Ant Design Vue（`paimeng-ai-code-mother-frontend/`）
- 后端：独立 NestJS 服务（`paimeng-ai-code-mother-backend/`）
- 生成的应用：静态 HTML/CSS/JS 或 Vue/React + Vite，运行在隔离的 Docker 容器中
- 生成技能：后端根目录 `.paimeng/skills/`（`static`、`vue`、`react`）
- 旧 Java 实现归档在 `deprecated/`，不参与运行

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

模型技能说明位于 `paimeng-ai-code-mother-backend/.paimeng/skills/`。每个 `<name>/SKILL.md` 必须包含 Codex 风格的 YAML frontmatter（`name`、`description`），目录名必须与 `name` 一致；平台通过 `load_skill` 只读返回正文，通过 `read_skill_resource` 读取 `references/`、`scripts/`、`assets/` 下的文本资源。

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

## 数据与运行目录

- PostgreSQL、Redis 数据在 Compose 命名卷中。
- 生成的源码、依赖、构建产物、任务日志在 `paimeng-ai-code-mother-backend/runtime/`，已加入 `.gitignore`。
- 应用容器使用标签 `paimeng.project=paimeng-ai-code-mother`，只清理本项目资源。
- 运行时镜像名为 `paimeng-app-runtime:<hash>`，由 `docker/runtime/Dockerfile` 构建。

## 检查

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

接口契约见 [`docs/api.md`](docs/api.md)，OpenAPI 文档在 `http://127.0.0.1:8123/api/v3/api-docs`。

黑盒验收（需先启动后端与基础设施）：

```bash
cd paimeng-ai-code-mother-backend
npm run test:acceptance
npm run test:acceptance:concurrency
```

完整验收记录见 [`docs/acceptance.md`](docs/acceptance.md)。

## 当前范围与限制

- 单机、单 NestJS 实例（Redis 单实例锁）；不支持多副本或跨机调度。
- 后端重启会终止进行中的运行并标记失败，不自动续跑；预览会在下次访问时重建。
- 每个用户最多 5 个应用同时运行，整机同时最多 5 个活跃预览。
- 生成应用只使用白名单内的前端依赖，不提供后端、数据库、密钥或外网访问。
- 安装/构建任务容器默认 1536 MiB，可用 `TASK_MEMORY_MB` 调整；整机内存预算与宿主预留见 `.env.example`。
- 静态应用由平台直接提供页面并监听源码变化自动刷新，不需要 `package.json`；Vue/React 应用使用平台约定的 `dev`/`build` 脚本。
- 首版不支持源码下载、部署分享、精选、管理后台、版本回滚、自动摘要与中断续跑。
