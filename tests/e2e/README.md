# 浏览器关键流程测试

`pnpm test:e2e` 使用根 runner 构建前后端、创建独立 PostgreSQL 和 Redis、重放迁移，再运行 Playwright。测试不需要产品运行时镜像；生成应用仅使用静态 HTML。

## 启动约定

直接运行 `pnpm exec playwright test --config playwright.config.mjs` 时，调用方必须先完成构建与迁移，并提供以下变量：

| 变量 | 要求 |
| --- | --- |
| `CI_TEST_ISOLATED` | 必须为 `1` |
| `CI_TEST_DATABASE_URL` | 独立 PG，loopback 地址，库名为 `paimeng_ci_<至少六位随机值>`；不接受查询参数 |
| `CI_TEST_REDIS_URL` | 独立 Redis，loopback 地址，固定 `/15`；不接受查询参数 |
| `CI_TEST_WORK_DIR` | 已创建的绝对路径；自身和父目录均在系统临时目录下、当前用户所有、权限 `0700`；两层都不能有 `.env` |
| `CI_TEST_WEB_PORT` | 可选，默认 `4173` |
| `CI_TEST_BACKEND_PORT` | 可选，默认 `18123` |
| `CI_TEST_MODEL_PORT` | 可选，默认 `18124` |

Playwright 启动 `node scripts/ci/browser-server.mjs`，不复用已有服务。启动器只读取构建产物，以 `CI_TEST_WORK_DIR` 为 cwd 运行生产 `dist/main.js`。它不负责构建、迁移或创建、删除数据库容器。

主站为 `http://paimeng.localhost:4173`，预览为 `http://app-{id}.preview.paimeng.localhost:4173`。二者来源不同，但站点相同，符合预览 Cookie 的 `SameSite=Lax` 约束。Chromium 将 `*.localhost` 映射到 `127.0.0.1`；所有测试服务器只监听 loopback。端口覆盖会同时更新主站、代理与预览地址。

后端环境使用白名单重新构造，PG、Redis、模型地址均由测试指定。`AI_*` 不继承宿主配置，`DOCKER_BIN=/bin/false`，运行目录与日志写入临时目录。前端由 Node 提供静态文件，`/api` 和预览 Host 原样代理到后端；没有 Vite 环境文件加载，也没有业务 API mock。

## 覆盖范围

套件只有四个测试，Chromium 单 worker、无重试。单个测试限时 45 秒，整个套件限时 180 秒。

1. UI 注册、登录、创建应用、自动发送首条需求，验证最终回复与跨源 iframe 内容，刷新后恢复历史和预览。API 补充验证其他账号不能访问应用、历史、队列、运行和预览票据，预览 Origin 不能修改主站数据，无授权的预览请求返回 401。
2. 确认运行中后通过 UI 插话，刷新中断 SSE 并重连。刷新前必须先看到一段只存在于模型流、从不落库的中间文本；刷新时对 `/api/app/run/stream` 的订阅必须是同一 `runId`、HTTP 200、`text/event-stream`，且重放流里重新出现那段中间文本。插话必须进入同一运行、状态为 `applied`，后端发往固定模型服务的请求必须包含插话，最终回复和预览必须包含插话结果。
   这组断言的作用是：把 SSE 订阅改成 500 或让流不再推送，用例必须变红。只比对终态做不到这一点——前端有队列轮询与状态核对兜底，SSE 全坏也能显示完成。
3. 确认 `running` 后添加普通等待消息，再通过 UI 停止。要求严格的 `cancelled` 终态、队列暂停且保留原等待消息、模型连接已中止。刷新后等待消息仍在且未产生新运行。
4. 本地模型返回 Responses `response.failed`，运行必须为 `failed / MODEL_ERROR`。刷新后保留失败历史，通过 UI 继续队列，新运行可以成功。

固定模型通过真实 HTTP Responses SSE 依次返回 `update_plan`、`write`、最终文本。后续步骤要求收到上一步真实工具的成功结果。插话和取消使用最长 20 秒的显式闸门，以队列、运行和模型状态同步，不依赖固定 sleep。

## 产物与清理

失败 trace 和截图写入仓库根目录 `test-results/`，与临时服务目录分离，供 CI 上传。此配置只运行不含真实模型密钥的固定模型流程。trace 会包含临时测试账号与会话，保留期限由 CI 配置决定。

后端日志位于 `CI_TEST_WORK_DIR/browser-backend.log`。运行目录由根 runner 的 `finally` 删除，所以启动器在退出时会把它复制到 `test-results/browser-backend.log`（CI 失败时随 `test-results/` 一起上传）；非零退出时还会把末 40 行直接打印到日志里。PG、Redis 容器与临时目录同样由外层 `finally` 销毁，取消信号会立即升级为强杀，保证清理有时间执行。

webServer 启动限时 35 秒，后端就绪探测限时 25 秒，单次探测限时 1 秒。代理有空闲和总时长限制。SIGTERM、SIGINT 会关闭连接并终止后端进程组，超过宽限期使用 SIGKILL。后端守护进程还监听父进程 IPC 断开，并设置最大存活时间，避免启动器异常退出留下后端后代。

## 未覆盖

不验证真实模型质量、付费网关、Docker 安装与构建、Vue/React 生成、容器预览和 WebSocket。浏览器刷新覆盖 SSE 订阅断开后的恢复，不覆盖模型 TCP 半包断流、真实断网或后端崩溃重启。仅验证桌面 Chromium，不覆盖移动端及其他浏览器。
