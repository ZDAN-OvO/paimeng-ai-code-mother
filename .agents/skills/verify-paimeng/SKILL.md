---
name: verify-paimeng
description: 用仓库现成的 QA CLI（pnpm verify run <功能>）复跑 Paimeng 的固定浏览器用例并留存证据。只在验证目标已被五个现有用例覆盖时使用：注册登录与生成预览（generation）、访问保护（access）、运行中插话与 SSE 重订阅（steer）、停止生成（cancellation）、失败后继续队列（recovery）；或整批收尾、合并前做这五项回归。现有用例没覆盖的页面或交互、临时看效果、截图和手动点验，用 T3 Code 内置的浏览器交互验证。不影响用户行为的模块内部调整走 pnpm test:module；真实模型或容器验收走后端 test:acceptance、test:acceptance:concurrency。
---

# 验证 Paimeng

主界面是浏览器里的 Vue 网页。本技能只管仓库自带的 QA CLI `pnpm verify`（`scripts/verify/cli.mjs`），在仓库根目录执行；它用无头 Chromium + Playwright 驱动五个现有用例。验证目标没被这些用例覆盖时，即使属于这五个功能，也用 T3 Code 内置的浏览器交互验证，不为一次性检查新增 spec。

## 证明边界

一次 `run` 是真的：Vue 静态构建、NestJS 生产构建、PostgreSQL 16、Redis 7、迁移、队列、SSE、`app-{id}.preview.paimeng.localhost` 独立来源预览。

一次 `run` 是替身：模型固定为 `paimeng-e2e-fixed`（本地 Responses SSE 服务，按场景返回 `update_plan` → `write` → 最终文本）；后端的 `DOCKER_BIN` 指向 `tests/e2e/docker-audit.sh`，调用即失败并记账。所以它**不证明**真实模型质量、付费网关、容器安装与构建、Vue/React 生成或容器预览。汇报时照此写明，不要把替身路径说成真实。

## Launch

没有常驻实例，也没有单独的 launch 子命令。每次 `pnpm verify run <功能>` 是一次有界的完整生命周期：

1. 构建前后端。
2. 起本次专属的 PG / Redis 容器（标签 `paimeng.ci=<随机 token>`、动态端口），重放迁移。
3. 起 `scripts/ci/browser-server.mjs`：静态前端、真实后端 `dist/main.js`、固定模型，全部只听 loopback 动态端口。
4. 轮询 `/__e2e/ready`（背后是后端 `/api/health/ready`），通过后才写 `lifecycle.ready=true`。这是本实例可用的唯一证明。
5. 只跑所选 `tests/e2e/<功能>.spec.mjs`。
6. `finally` 中停服务、删容器和临时目录，再复查端口、容器、目录。

`pnpm verify list` 列出可用功能名。`all` 跑全部五个，只在整批收尾时用。

## Doctor

```bash
pnpm verify doctor
```

只读前置诊断：Node ≥ 22.8、pnpm、Docker 守护进程、Playwright Chromium 已安装。输出 JSON，`ok:false` 时退出码 1，`run` 开头也会自动跑一次并拒绝继续。它不检查任何正在运行的实例，不能拿来判断开发实例是否健康；实例可用性只由 `run` 自己的 `lifecycle.ready` 证明。Chromium 缺失时执行 `pnpm exec playwright install chromium`。

## Drive

```bash
pnpm verify run generation   # 或 access | steer | cancellation | recovery
```

退出码 0 且最后打印的 JSON `ok:true` 才算通过。功能对应的用户路径、选择器和断言见 [`features/README.md`](features/README.md)，验证目标被哪个用例覆盖就跑哪个。

仅要求截图、临时看效果或手动点验时，用 T3 Code 内置的浏览器交互验证，不因涉及这五个功能而跑 CLI。

按改动面选层级：

- 单个后端/前端/CI/集成模块：`pnpm test:module <backend|frontend|ci|integration> <文件名主干>`，名称必须完全匹配，用 `pnpm test:module <scope> --list` 查。这是默认的快路径。
- 用户可见行为已被现有用例覆盖（对照 `features/` 下各功能的 Sub-features 与 Gotchas 里的不覆盖项）：再跑对应的 `pnpm verify run <功能>`。
- 现有用例没覆盖的页面或交互，即使属于这五个功能：用 T3 Code 内置的浏览器交互验证。

失败就是失败：用例失败、跳过、重试、缺 trace/截图、清理不全都会让 `ok:false`。功能名无效或预检失败发生在创建证据目录之前，只有 stderr 和退出码 1、没有 manifest，按命令、退出码和 stderr 汇报。去修代码或修用例本身并写明理由，不放宽断言、不删用例、不改门禁。

## Evidence

每次 `run` 写一个独占目录 `test-results/verify-<毫秒时间戳>-<8位随机>/`，成功也保留：

- `manifest.json`：`ok`、`feature`、`head`、`dirty`、`model`、`runtime: docker-audit`、`preflight`、`lifecycle`、全部产物的路径/字节数/sha256，失败时有 `error`。
- `lifecycle.json`：`ready`、`ports`、`cleanup.{portsClosed,workRemoved,containersGone}`；失败时保留原始 `error`，清理检查异常记在 `cleanupErrors`，无法确认清理就按失败处理。
- `results.json`：Playwright JSON 报告。附件里有 `api-observation`（公共 API helper 发出的业务请求与响应，页面操作触发的网络请求另见 trace）、`model-<marker>`（固定模型场景 stats：`calls`、`requests`、`waiting`、`seenSteer`、`aborted`）、`final-page` 截图，steer 另有 `live-sse` 原始帧。
- `artifacts/<用例>-chromium/trace.zip` 与 `test-finished-*.png`：每一步操作与页面状态，用 `pnpm exec playwright show-trace <trace.zip>` 查看。
- `browser-backend.log`：后端日志。`docker-calls.log`：后端每次 Docker 调用的审计。替身对所有调用都返回失败，所以记录里的命令都没有真正执行。启动阶段正常会出现 `network inspect/create`、`ps -a --filter label=…`、`inspect paimeng-*`；任一行以 `run/create/start/stop/exec/build/kill/rm/pull/push/commit/cp/image/container/buildx` 开头，`globalTeardown` 就会判失败（规则在 `tests/e2e/global-teardown.mjs`）。

核对通过的最小清单：

```bash
d=<本次 run 最后打印的 JSON 里的 directory>   # 不要用 ls 取最新目录，并行或旧结果会选错
node -e 'const m=require(process.argv[1]+"/manifest.json");const l=m.lifecycle;console.log({feature:m.feature,ok:m.ok,ready:l?.ready,cleanup:l?.cleanup,trace:m.artifacts.filter(a=>a.path.endsWith("trace.zip")).length,png:m.artifacts.filter(a=>a.path.endsWith(".png")).length})' "$d"
```

要求 `feature` 等于本次所选功能，`ok`、`ready` 为 true，`cleanup` 三项全 true，trace 与 png 数量大于 0。trace 含临时测试账号与会话 cookie，不外传。

## Cleanup

清理由 `run` 自己完成，失败路径也一样；外层在删除临时目录前兜底保留后端日志与 Docker 审计，即使 Playwright teardown 没完成：停掉它起的浏览器服务和后端进程组，按本次 token 和容器名删除 PG/Redis 容器，删除 `CI_TEST_WORK_DIR`，再把复查结果写进 `lifecycle.json`。复查不通过时 `run` 报错退出。没有单独的 cleanup 命令。

若 `cleanup` 有 false，按 `lifecycle.json` 里的 `ports` 查占用者、按 `lifecycle.isolation.token` 运行 `docker ps -a --filter label=paimeng.ci=<本次 token>` 查残留。`ports` 只在就绪后写入，`isolation` 只在容器启动后写入；启动或迁移阶段失败时它们可能缺失、`cleanup` 为 null，此时仍按失败汇报；容器删不掉时 stderr 会打印 `CI cleanup failed` 和 `docker rm -fv paimeng-ci-<token>-*` 提示，按该容器名排查。只处理本次的对象，不按进程名杀、不 prune。证据目录不属于清理范围，保留在 `test-results/verify-*/`，由人决定何时删除。

## Helpers

- `pnpm verify list | doctor | run <功能|all>`：上文全部流程。
- `pnpm test:module <scope> <名称>` / `pnpm test:module <scope> --list`：独立模块快测。
- `pnpm test:cancel`：中途取消 runner 后无残留进程、容器、端口；改了 `scripts/ci/**` 或进程清理逻辑时跑。
- 功能地图：[`features/README.md`](features/README.md)。
