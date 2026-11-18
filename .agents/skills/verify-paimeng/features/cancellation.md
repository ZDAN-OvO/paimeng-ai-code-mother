# 停止生成

用户在生成进行中点停止，当前运行只能以 cancelled 结束，队列自动暂停，之前排队的普通消息保留，刷新后状态不变且不会自动开新一轮。

## Sub-features

- `cancel-queue-normal` 运行中以 `普通` 模式追加一条等待消息，状态 `queued`。
- `cancel-stop` 点 `停止生成`，运行终态为 `cancelled`。
- `cancel-paused` 队列 `paused:true`、`activeRun:null`，等待项仍是 `queued`。
- `cancel-aborted` 模型连接被中止。
- `cancel-reload` 刷新后仍暂停，等待消息可见，未产生新运行。

## How to get to it (user POV)

- 生成运行中，`发送模式` 选 `普通`，输入下一条需求，点 `发送消息`。
- 点 `停止生成`。
- 刷新对话页。

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` 为 `ok:true`。
- 固定模型场景 `hold`，运行停在闸门直到被取消。

- **进入运行中。** 注册、登录、创建后轮询到 `running`，模型 stats `waiting:true`。
- **排队普通消息。** `发送模式` 选 `普通`，填 `下一轮生成等待页 <marker>`，点 `发送消息`。响应 `{mode:'normal',status:'queued'}`；出现 `普通消息 · 排队中`；当前运行仍 `running`。
- **停止。** 点 `停止生成`。运行轮询到 `cancelled`，runId 不变。
- **队列暂停。** 轮询 `/api/app/chat/queue?appId=…` 到 `{paused:true, activeRun:null}`，等待项 `{status:'queued',mode:'normal'}`。页面出现 `已暂停`、`已停止…` 按钮、`继续队列` 按钮。模型 stats `aborted:true`。
- **刷新。** `page.reload()` 后 `已暂停` 与等待消息原文可见；首轮仍 `cancelled`；等待项的运行查询为 404（未派发）；模型 `requests` 为 1。
- **执行。** `pnpm verify run cancellation`。退出码 0，`manifest.ok:true`。

## Gotchas

- 终态必须严格是 `cancelled`。`failed` 或 `completed` 都是缺陷，不能放宽成「已结束」。
- 必须先确认 `running` 和模型 `waiting:true` 再停止，否则可能取消的是尚未派发的队列项，证明的是另一条路径。
- `requests` 大于 1 说明暂停后仍派发了等待项。
- 这里只证明用户取消；runner 中途被杀后无残留由 `pnpm test:cancel` 证明。
