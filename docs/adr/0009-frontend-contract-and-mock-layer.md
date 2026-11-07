# ADR 0009：前端只经 `/api/**` 取数，mock 用 route handler 承载

- 状态：已接受
- 日期：2026-11-07

## 背景

原型把项目、对话、版本全部放在浏览器 localStorage 里，生成过程由 `runner.ts` 的 `setTimeout` 脚本直接改 React 状态。后端要按前端定好的 API 开发，需要一条可验证的边界：前端调用的路径、请求体、响应与事件流，就是后端要实现的东西。

可选做法：

1. 保留浏览器内的假仓库，另写一份接口文档给后端。
2. 前端发真实 HTTP，mock 由 Next route handler 返回固定数据。
3. 用 MSW 在浏览器层拦截请求。

## 结论

选 2。前端只经 `src/lib/api` 调 `/api/**`；`src/app/api/**` 的 handler 做参数校验后转调 `src/mock/**`；契约的唯一来源是 `src/shared/api/schemas.ts` 的 zod schema，`docs/api.md` 是同一份内容的可读版本。mock 状态落盘在 `data/mock/state.json`，进程重启可续。

## 后果

- 后端接手时只替换 handler 内部实现，URL、请求体、响应形状、SSE 事件名不变；前端不需要跟着改。
- 契约错一次会连累三层，所以先评审 `docs/api.md` 再写业务代码成为固定步骤。
- 方案 1 的文档会与实现漂移，方案 3 把契约藏在 Service Worker 里、且无法在服务端复用；因此不采用。
- `data/mock/` 是运行时数据，已被 `.gitignore` 覆盖；它不构成生产存储，后端接入数据库后应删除该目录的读写。
