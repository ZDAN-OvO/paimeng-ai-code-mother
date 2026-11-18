# 访问保护

一个用户生成的应用、历史、队列、运行和预览票据，其他账号拿不到；预览来源不能借用户 cookie 修改主站数据；没有票据的预览请求被拒绝。

## Sub-features

- `access-cross-account` 另一个账号读应用、历史、队列、运行都返回 403。
- `access-preview-ticket` 另一个账号申请预览票据返回 403。
- `access-origin` 带预览 Origin 的主站写请求返回 403。
- `access-unauth-preview` 无票据访问预览 Host 返回 401。

## How to get to it (user POV)

- 用户 A 正常生成一个应用并看到预览。
- 用户 B 在另一个浏览器上下文注册后，尝试访问 A 的应用与预览。
- 预览页里的脚本尝试以用户 A 的会话调用主站修改接口。

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` 为 `ok:true`。
- 用户 A 已按 [生成与预览](./generation.md) 的路径完成一次 `completed` 运行。

- **A 生成。** 同 generation 的注册、登录、创建、完成步骤。记下 `appId`、`runId` 与 iframe `src`。
- **B 注册。** `browser.newContext()` 打开 `/user/login`，经浏览器 `POST /api/user/register` 注册 `other_<16位>`。`code:0`。
- **跨账号读取。** B 依次请求 `/app/get/vo?id={appId}`、`/chatHistory/app/{appId}`、`/app/chat/queue?appId={appId}`、`/app/run/status?runId={runId}`。每个都是 HTTP 403 且 body `{code:40300,data:null}`。
- **预览票据。** B 请求 `POST /app/preview/access {appId}`。HTTP 403，`code:40300`。
- **来源保护。** 用原生 HTTP 发 `POST /api/app/update`，Host 为主站、Origin 为预览来源、Cookie 为 A 的 `pm_sid`。HTTP 403，`{code:40300,data:null}`。
- **无票据预览。** 原生 HTTP 以预览 Host 请求 `/`。HTTP 401。
- **执行。** `pnpm verify run access`。退出码 0，`manifest.ok:true`；`results.json` 中 `api-observation` 附件逐条记录了 403。

## Gotchas

- 浏览器不允许手工覆盖 Origin，来源保护只能用原生 HTTP 证明；Node `fetch` 会改写 Host，也不能用。
- 403 必须带 `code:40300`。只看状态码会放过「返回 403 但泄露 data」的实现。
- 这里只证明 API 层拒绝，不证明 iframe 沙箱属性或 DOM 隔离。
