# 运行中插话

用户在生成进行中用「插话发送」补充要求，插话进入当前这一轮；刷新页面会断开 SSE，新页面重新订阅同一个运行，服务端继续推送到完成，最终结果包含插话。

## Sub-features

- `steer-send` 运行中以 `插话发送` 模式发消息，挂到当前 runId。
- `steer-pending` 插话显示 `插话发送 · 等待插入当前轮次`。
- `steer-resubscribe` 刷新后对 `/api/app/run/stream` 重新订阅同一 runId。
- `steer-live-sse` 独立长连接跨过放行点，收到放行后才有的帧，并以唯一的 `[DONE]` 收尾。
- `steer-applied` 完成后插话状态为 `applied`，回复与预览包含插话结果。

## How to get to it (user POV)

- 生成运行中，在对话页切换 `发送模式` 为 `插话发送`，输入内容，点 `发送消息`。
- 生成未结束时刷新页面。

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` 为 `ok:true`。
- 固定模型场景 `hold`：首个模型请求停在闸门，直到用例调用 `release`。

- **进入运行中。** 注册、登录、创建后轮询到 `running`，模型 stats `waiting:true`，按钮 `停止生成` 可点。
- **插话。** 在 `发送模式` 组里点 `插话发送`，在 `描述你想做的页面，或继续提出修改…` 填 `插话-<12位>`，点 `发送消息`。队列响应 `mode:'steer'`、`runId` 等于当前运行；输入框清空；出现 `插话发送 · 等待插入当前轮次`。
- **刷新重订阅。** `page.reload()`，捕获 `POST /api/app/run/stream`。HTTP 200，`content-type` 含 `text/event-stream`，请求体 `runId` 等于当前运行。刷新后中间文本 `partial`、`停止生成`、插话等待标签仍在。
- **持续推送。** 用 `pm_sid` 另开原生长连接订阅同一 runId，先收到 `"type":"start"` 重放帧，再放行模型。流自行结束且无异常；帧中有 `data-validation` 且 `check:"source"`、`页面已完成 <marker>`、`data-run` 的 `status:"completed"`；`[DONE]` 只有一个且是最后一帧，在终态帧之后。
- **结果。** 运行 `completed` 且 runId 不变；页面出现 `页面已完成 <marker>；已应用插话：<插话>`、`插入指令`、插话原文；预览内有 `页面已生成；已应用插话：<插话>`。队列 `requestedItem` 为 `{status:'applied', runId}`；模型 stats `seenSteer:true`。
- **执行。** `pnpm verify run steer`。退出码 0，`manifest.ok:true`；`results.json` 有 `live-sse` 原始帧附件。

## Gotchas

- 刷新前不断言助手气泡里的中间文本：运行中加载历史会用快照覆盖未落库的实时内容（issue #183）。修复后应把断言加回 spec。
- 页面上看到中间文本不算 SSE 证据，历史接口也能带出它。持续推送只由跨过放行点的长连接证明。
- 必须先等 `live.ready` 和重放帧再放行；顺序反过来，「订阅晚到 + 只回快照」的实现也能过。
- 闸门最长 20 秒，用例超时多半是插话没有被消费，查 `browser-backend.log`。
- 不覆盖页内自动重连、TCP 半包、真实断网或后端崩溃重启。
