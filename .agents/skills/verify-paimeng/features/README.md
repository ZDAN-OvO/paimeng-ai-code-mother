# Paimeng 验证地图

这里记录 `pnpm verify` 五个现有用例覆盖的用户行为与断言。先读本页，再按验证目标打开对应功能文件。每个功能对应一个 `tests/e2e/<功能>.spec.mjs`，由 `pnpm verify run <功能>` 驱动。

## 基线前置

- 仓库根目录执行；`pnpm verify doctor` 返回 `ok:true`。
- 每次 run 自建空库、空 Redis、临时工作目录与动态端口，不连接开发实例，也不读 `.env`。
- 主站 `http://paimeng.localhost:<webPort>`，预览 `http://app-{appId}.preview.paimeng.localhost:<webPort>`；Chromium 把 `*.localhost` 映射到 `127.0.0.1`。
- 每个用例在 `/user/register` 新注册一个 `browser_<16位>` 账号，不依赖种子数据。
- 固定模型场景由 `model.create(mode)` 创建：`normal` 正常完成，`hold` 停在闸门等待放行（最长 20 秒），`fail` 返回 `response.failed`。

## 驱动约定

- 选择器用占位文本、ARIA 角色与可访问名称，原文照抄，全部来自 `tests/e2e/fixtures.mjs` 与各 spec。
- 业务 API 只经浏览器 `fetch('/api…')` 打到真实后端，没有 `page.route` 或业务替身；需要保留 Host/Origin 的探测用原生 HTTP。
- 等状态用 `expect.poll` 读 `/api/app/run/status`，不用固定 sleep。
- 一次只驱动一个功能；`all` 留给整批收尾。

## 证明与失败汇报

- 证据在 `test-results/verify-*/`，结构见 `SKILL.md` 的 Evidence。
- 证明同时包含用户动作（trace）、结果画面（png）、后端副作用（`api-observation` 与运行/队列状态）和模型侧观察（场景 stats）。
- 前置不满足或断言失败时，按失败汇报命令、`manifest.error` 与相关产物，不改弱断言让它通过。
- 某入口没跑到，就写没跑到，不用别的功能的通过来代替。

## 功能条目约定

每个功能文件以 H1 和一段用户行为说明开头，然后依次是四个 H2：`Sub-features`、`How to get to it (user POV)`、`Driving it with pnpm verify`、`Gotchas`。

## 功能

- [生成与预览](./generation.md)：注册登录、一句话生成静态页、独立来源预览、刷新恢复。
- [访问保护](./access.md)：跨账号拒绝、预览来源不能写主站、无票据预览返回 401。
- [运行中插话](./steer.md)：插话进入同一轮、刷新重新订阅、服务端持续推送 SSE。
- [停止生成](./cancellation.md)：运行中停止、终态 cancelled、队列暂停并保留等待消息。
- [失败后恢复](./recovery.md)：模型失败保留 failed 历史，继续队列后新一轮成功。
