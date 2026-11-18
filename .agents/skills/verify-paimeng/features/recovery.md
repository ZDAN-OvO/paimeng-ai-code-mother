# 失败后恢复

模型出错时运行以 failed 结束并保留失败历史，队列暂停；用户再发一条消息并点继续队列，新一轮正常完成，旧的失败记录不被改写。

## Sub-features

- `recovery-failed` 运行终态 `failed`，`errorCode:'MODEL_ERROR'`，页面显示失败原因，无预览 iframe。
- `recovery-history` 刷新后仍显示 `生成失败` 记录。
- `recovery-resume` 新消息入队后队列为暂停，点 `继续队列` 后新运行 `completed`。
- `recovery-immutable` 首轮仍是 `failed`，新运行 runId 不同。

## How to get to it (user POV)

- 创建应用后生成失败，对话页显示失败消息。
- 刷新查看历史。
- `发送模式` 选 `普通` 再发一条需求，点 `继续队列`。

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` 为 `ok:true`。
- 固定模型场景 `fail`：首个请求返回 `response.failed`，之后的请求正常完成。

- **失败。** 注册、登录、创建后轮询到 `failed`，`errorCode` 为 `MODEL_ERROR`。页面出现 `模型请求失败：模型故障 <marker>`；`应用预览` iframe 数量为 0。
- **刷新。** `page.reload()` 后可见以 `生成失败` 开头的按钮。
- **重发。** `发送模式` 选 `普通`，填 `重新生成静态页面 <marker>`，点 `发送消息`。队列 `paused:true`。
- **继续队列。** 点 `继续队列`。新消息的运行轮询到 `completed`，runId 不同于失败那轮；完成态同 generation（`页面已完成 <marker>`、预览标题、`预览运行中`）。
- **历史不变。** 首条消息的运行仍为 `failed`。
- **执行。** `pnpm verify run recovery`。退出码 0，`manifest.ok:true`。

## Gotchas

- 失败后队列必须暂停，重发不能自动派发；`paused:false` 是缺陷。
- 失败文案在页面上可能不止出现一次，spec 用 `.first()` 取第一处；改成精确唯一匹配会误报。
- 只覆盖模型返回 `response.failed`，不覆盖网关超时、构建失败或后端重启后的遗留运行收尾。
