# Brief: 把原型落成可对接后端的生产前端（真实 HTTP mock + 类型化契约）

- Stage: execute
- Source: 用户要求「将 `src/` 的原型调整为标准 react 前端工程，去除网页中的原型标志，数据使用 mock 数据，之后后端会使用定好的前端 api 进行开发」；经两轮确认：留在 Next.js App Router；mock 走真实 HTTP route handlers；删 UI 演示入口但把脚本搬进 mock 服务端；先交契约再分三个 PR 落地。

## Goal

- 交付一份后端可以直接照着实现的前端 API 契约（路径、请求/响应、SSE 事件、错误码、TS 类型），前端所有业务数据只经由该契约取得。
- 把 `src/` 从「一次性原型」变成生产形态的前端工程：真实路由不再带 `/prototype` 前缀、组件按域拆分、界面与代码里不再有原型标志。
- 后端接手时只替换 `/api/**` 的实现，前端调用点、状态形状与路由不改。

## Context

- 现状：Next.js 16 App Router + React 19 + TS + Tailwind 4 + shadcn/ui；`src/prototype/**` 约 8.7k 行，数据存 localStorage（key `paimeng.prototype.v1`），一轮生成由 `runner.ts` 的浏览器脚本模拟；`src/app` 只有 `/`、`/api/health` 与 `/prototype*`。
- `docs/architecture.md` 第 3、6 节规定 Next.js 在仓库根、前端在 `src/app`、业务在 `src/server`；13 条验收路径见 `docs/mvp.md`。
- 既有契约：`src/prototype/README.md` 的一张接口表，自标为「旧版提案」，缺审批与运行状态协议；字段命名已对齐 `src/server/db/schema.ts`。
- 前端状态比文档更全：`Part` 已含 `plan`/`todos`/`tool`/`reasoning`/`selection`/`image`，`RunStatus` 已含 `budget_exhausted`/`rejected`，契约需按这些补齐。
- 后端尚未实现，本轮不接数据库、Docker 与模型；契约的唯一使用方是后续在同一仓库实现 `/api/**` 的后端开发。

## Materials

- 主输入：`src/prototype/`（`types.ts`、`mock-data.ts`、`store.tsx`、`runner.ts`、`components/`）与 `src/prototype/README.md` 的接口表。
- 次输入：`docs/architecture.md`、`docs/mvp.md`、`src/server/db/schema.ts`、`docs/briefs/v0-parity-restyle.md`（形态基线）。
- mock 内容只能来自 `mock-data.ts` 与既有种子消息；契约里缺的字段留空或标「待定」，不编造业务数据。
- 契约产物落在 `docs/api.md`，字段名与 `schema.ts` 对齐，类型从代码导出而不是在文档里手抄两份。

## Boundaries

- 不换技术栈：不引入 Vite 或 React Router，不改 `docs/architecture.md` 第 3、6 节的模块边界。
- 本轮不实现真实后端：不连数据库、不建沙箱、不调模型、不做鉴权；`/api/**` 只返回 mock 数据，且不得伪装成已实现能力。
- 不删产品功能：先规划、语音输入、技能页、发布页保留并改走 API；只删 HUD 悬浮条、「演示」菜单、「未接通」标记、原型说明文案与 README 里的原型定位。
- 不改 13 条验收路径的语义，不新增第 14 条范围；视觉延续 v0 基线，不重做设计。
- 不把 mock 藏在 Service Worker 或组件内的假仓库：前端只经 `fetch` 调 `/api/**`。

## Done

- 第一步只交三样：`docs/api.md`（端点、请求/响应、SSE 事件、错误码）、目标目录树、路由对照表（旧 `/prototype*` → 新路径）；确认后才改代码。
- 之后三个 PR：①路由与目录结构 → ②类型化客户端 + mock route handlers（含 13 条演示剧情） → ③删除原型标志并复跑 13 条路径。
- 每个 PR 合入前 `npm run type-check`、`npm run lint`、`npm run test`、`npm run format:check`、`npm run build` 全绿，浏览器控制台无报错。
- 每个 PR 附浏览器录屏（GIF 嵌入正文并保留原视频链接），标明每段录像演示的状态；没有可见界面的改动在 PR 说明。
- 交付后 HUD 与「模拟」字样不再出现，13 条路径在无后端、无数据库的条件下仍能走通。

## Assumptions

- 契约文档放 `docs/api.md`；`src/prototype/README.md` 的表合并进去后，该 README 随 PR③删除或降为历史说明。
- 「标准 React 前端工程」按确认的方案 (a) 执行：留在 Next.js，拆为 `src/app`（路由）+ `src/features`（域组件与状态）+ `src/lib/api`（客户端与类型）；具体目录名在契约评审时定。
- mock 服务端的剧情（正常、修复、失败、执行上限、旧证据、八工具、未信任脚本）由请求参数或 mock 场景表决定，不再由 UI 开关触发。
- 明暗主题、左栏折叠、右栏宽度等纯浏览器偏好继续存 localStorage，不算业务数据。
- 发布页由 `/prototype/p/<deployKey>` 迁到根路径 `/deploys/<deployKey>`（原 `/p/<deployKey>` 假设被“路由用业务词”推翻，`docs/mvp.md` 契约 #8 的路径文本随之同步），`deployKey` 仍由 mock 生成。
