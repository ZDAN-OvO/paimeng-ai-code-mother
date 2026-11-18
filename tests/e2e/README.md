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

经 `pnpm test:e2e` 运行时，由 runner 自己启动 `node scripts/ci/browser-server.mjs` 并下发 `CI_TEST_EXTERNAL_WEBSERVER=1`，此时 Playwright 不再代管 webServer；直接跑 `playwright test` 时由 Playwright 启动它。前一种方式下浏览器服务与 runner 的其它子进程一样会被统一收掉，取消时不会留下孤儿。不复用已有服务。启动器只读取构建产物，以 `CI_TEST_WORK_DIR` 为 cwd 运行生产 `dist/main.js`。它不负责构建、迁移或创建、删除数据库容器。

主站为 `http://paimeng.localhost:4173`，预览为 `http://app-{id}.preview.paimeng.localhost:4173`。二者来源不同，但站点相同，符合预览 Cookie 的 `SameSite=Lax` 约束。Chromium 将 `*.localhost` 映射到 `127.0.0.1`；所有测试服务器只监听 loopback。端口覆盖会同时更新主站、代理与预览地址。

后端环境使用白名单重新构造，PG、Redis、模型地址均由测试指定。`AI_*` 不继承宿主配置，`DOCKER_BIN` 指向记录型替身 `tests/e2e/docker-audit.sh`（调用即失败并写入记录），运行目录与日志写入临时目录。`globalTeardown` 会断言过程中没有出现 `docker run/create/exec/build/rm` 这类真正执行或构建容器的命令——启动阶段的 `network inspect`、`ps --filter label`、`inspect paimeng-app-*` 属于只读探测，允许出现。前端由 Node 提供静态文件，`/api` 和预览 Host 原样代理到后端；没有 Vite 环境文件加载，也没有业务 API mock。

## 覆盖范围

每个用户功能独立放在一个 spec：`generation`、`access`、`steer`、`cancellation`、`recovery`。Chromium 单 worker、无重试，时间预算统一由 `environment.mjs` 推导。

单功能用 `pnpm verify run <功能>`；完整回归用 `pnpm test:e2e`。验证 CLI 的启动、证据和清理约定见 [verify-paimeng](../../.agents/skills/verify-paimeng/SKILL.md)。

1. `generation`：UI 注册、登录、创建应用、自动发送首条需求，验证最终回复与跨源 iframe 内容，刷新后恢复历史和预览。独立的 `history-race` 用例先截取真实的空助手历史，等实时文本可见后再送达旧历史，要求文本保留且助手气泡只有一条；它只随完整回归运行，不属于五项功能 CLI 的固定用例。
2. `access`：其他账号不能访问应用、历史、队列、运行和预览票据，预览 Origin 不能修改主站数据，无授权的预览请求返回 401。
3. `steer`：确认运行中后通过 UI 插话，刷新中断 SSE 并由新页面重新订阅同一运行（不覆盖页内自动重连）。刷新时对 `/api/app/run/stream` 的订阅必须是同一 `runId`、HTTP 200、`text/event-stream`。刷新前必须显示模型流的中间文本。服务端持续推送仍由下面那条长连接证明。插话必须进入同一运行、状态为 `applied`，后端发往固定模型服务的请求必须包含插话，最终回复和预览必须包含插话结果。
   中间的文本会落库，刷新后从历史里看得到，所以「界面上看得见」不构成证据；只重放旧帧再关流的实现也能带出这段文本。真正的证据是刷新后另开一条真实长连接、跨过放行点，要求它收到放行之后才会产生的写入校验帧（`data-validation` / `check: source`）和 `text-delta` 帧。页面侧那条订阅只用来证明「刷新后确实重订阅了同一个运行」。把订阅改成「200 空流」或「只重放旧帧就关流」，用例都会变红。
   这组断言的作用是：把 SSE 订阅改成 500 或让流不再推送，用例必须变红。只比对终态做不到这一点——前端有队列轮询与状态核对兜底，SSE 全坏也能显示完成。仍未覆盖的是「订阅成功但前端解析帧坏了」：轮询会兜底，终态照样正确。
4. `cancellation`：确认 `running` 后添加普通等待消息，再通过 UI 停止。要求严格的 `cancelled` 终态、队列暂停且保留原等待消息、模型连接已中止。刷新后等待消息仍在且未产生新运行。
5. `recovery`：本地模型返回 Responses `response.failed`，运行必须为 `failed / MODEL_ERROR`。刷新后保留失败历史，通过 UI 继续队列，新运行可以成功。

固定模型通过真实 HTTP Responses SSE 依次返回 `update_plan`、`write`、最终文本。后续步骤要求收到上一步真实工具的成功结果。插话和取消使用最长 20 秒的显式闸门，以队列、运行和模型状态同步，不依赖固定 sleep。

## 产物与清理

CI 失败时的 trace 和截图写入 `test-results/run-<时间>-<pid>/`。`pnpm verify run <功能>` 则在成功和失败时都保留证据，写入独占的 `test-results/verify-<时间>-<随机>/`：截图、trace、API 观察、模型场景统计、`results.json`、清理复查与带 SHA256 的 `manifest.json`。目录由 runner 下发，Playwright 不会清空另一次运行的产物。

后端日志和 Docker 审计在临时服务目录删除前搬入本次结果目录。`verify-*` 不参与 CI 的一天旧目录清理；证据在服务、容器、临时目录清理后继续保留。trace 含临时测试账号与会话，分享前应按需处理。

PG、Redis、后端和浏览器服务由外层 `finally` 清理；取消先请求退出，再在有界宽限期后强杀所属进程组。`pnpm test:cancel` 验证 CI 入口，`node scripts/ci/cancel-check.mjs verify` 验证 CLI 入口。

webServer 启动限时 35 秒，后端就绪探测限时 25 秒，单次探测限时 1 秒。代理有空闲和总时长限制。SIGTERM、SIGINT 会关闭连接并终止后端进程组，超过宽限期使用 SIGKILL。后端守护进程还监听父进程 IPC 断开，并设置最大存活时间，避免启动器异常退出留下后端后代。

## 未覆盖

不验证真实模型质量、付费网关、Docker 安装与构建、Vue/React 生成、容器预览和 WebSocket。浏览器刷新覆盖 SSE 订阅断开后的恢复，不覆盖模型 TCP 半包断流、真实断网或后端崩溃重启。仅验证桌面 Chromium，不覆盖移动端及其他浏览器。
