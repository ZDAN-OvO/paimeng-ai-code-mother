# Brief: 首页模板入口、折叠栏与侧栏行为对齐 v0

- Stage: execute
- 备注（2026-11-08 续）：入口语义已改为「首页/模板先建 Draft，用户点『创建项目』转正，不自动部署」；本文件里「一键起项目 / 自动跑首轮」的表述以该变更为准，草稿相关的 Done 原见 `docs/evidence/draft-to-project/`（2026-11-09 已过期删除，可从 git 历史取）。
- Source: 用户 4 条截图反馈：模板卡「用这个模板开始」应建项目并进对话页；去掉用户可见的「先规划」；任务卡并入折叠栏、只有最终回复不折叠、AI 消息不要 logo；对话页侧栏点击不跳页、只保留一个高亮，「对话」是会话历史。

## Goal

- 首页模板卡一键起项目：点「用这个模板开始」直接创建 Project 与首个 Chat、落一版模板产物、自动跑首轮，停在 `/chat/<chatId>` 三栏页，右侧预览立刻有内容。
- 规划变成 agent 自主行为：界面上不再有用户可切换的「先规划」，发送消息接口（`POST /api/chats/<chatId>/messages`）也不再接受 `plan` 字段；命中「先规划 / 先做计划 / 先出方案」等说法时仍产出方案卡待批准。
- 对话区按 v0 折叠：折叠头之外只留最后一段回复，中途的 任务卡、工具组、思考、中间文字都进折叠体；AI 消息不再渲染 logo 头像。
- 左侧栏改为本地导航：四个入口都不再整页跳走，同一时刻只有一个高亮，「对话」展示全局会话历史；进入具体会话时只有该会话条目高亮。

## Context

- 仓库是 Next.js 16 App Router 前端，数据全部经 `fetch('/api/**')`；`src/mock/**` 是临时后端，24 个 route handler 只做校验与转调。契约以 `src/shared/api/schemas.ts` 为准，`docs/api.md` 是它的可读镜像。
- 模板现状：`GalleryTemplate` 自带 `prompt`、`templateId`、`site`；`src/mock/seed/templates.ts` 有四个模板，`buildSite()` 能按 templateId 直接生成站点。但 `home-view.tsx` 的 `onUse` 只把 prompt 填进输入框并 `toast`，不建项目。
- 「先规划」现状：`chat-panel.tsx` 有 `planning` 本地开关，发送时带 `plan: true`；契约 `messageRequestSchema.plan` 是可选布尔，`docs/api.md` 第 43 行写明「`plan: true` 或输入命中关键词」；`src/mock/scenario.ts` 两条件都支持（`if (input.plan || wantsPlan(input.text))`）。
- 折叠现状与 v0 参考：`chat-panel.tsx` 的折叠体只装 reasoning 与工具组；`TodosCard`、`PlanCard` 与整段文字都渲染在折叠体外，所以收起时任务卡仍整块可见；AI 消息左侧固定渲染 `<PaimengMark size={20}>`。v0 收起时只有一行 `Worked for 5s`，展开才看细节，正文只放最终回复。
- 侧栏现状：`app-sidebar.tsx` 四个 `SidebarLink` 分别 `router.push('/')`、`/skills`、`/#templates`，「对话」写死 `active` 且点击切到本项目最近会话；项目树里的当前会话也有激活样式，于是出现截图里两个高亮。

## Materials

- 截图（`/tmp/`）：`pi-clipboard-6d055cad…png`（模板卡的「用这个模板开始」）、`pi-clipboard-90c0304d…png`（v0 模板起聊页）、`pi-clipboard-1fa858a6…png`（「先规划」按钮）、`pi-clipboard-f8f56475…png`（任务卡在折叠体外）、`pi-clipboard-aa3a454c…png`（v0 折叠形态）、`pi-clipboard-b6a68d52…png`（两个高亮）。
- 主要改动面：`src/features/home/{home-view,template-gallery}.tsx`、`src/features/workspace/{workspace,app-sidebar,workspace-store}.tsx`、`src/features/chat/{chat-panel,flow-cards}.tsx`、`src/features/skills/skills-view.tsx`。
- 后端侧：`src/mock/world.ts` 的 `createProject`、`src/mock/scenario.ts` 的 `wantsPlan`、`src/shared/api/schemas.ts`、`docs/api.md`。
- 只读这些文件与其直接依赖，不扩到 `src/server/**`、`migrations/`、`archive/`。缺数据时按模板 seed 现有内容走，不新造站点素材。

## Boundaries

- 不改 13 条验收路径的语义，也不改 `/api/**` 的路径与响应形状；唯一允许的契约变更就是删掉 `plan` 字段，并同步 `schemas.ts` 与 `docs/api.md`。
- 不删功能：语音输入、技能页内容、发布与版本、Design 选区、截图附件、stop 都要还能用；`/skills` 深链不能 404，重定向到 `/` 后在侧栏里打开技能面板。
- 不新增依赖，不动 `docs/architecture.md` §3 的模块边界，不引入真实后端、数据库或沙箱。
- 文案里不出现「原型 / 模拟 / 未接通」；界面语言保持中文。
- 侧栏不靠"两个都高亮"来兼顾：同一时刻只能有一个入口处于激活态。

## Done

- `/` 点模板卡的「用这个模板开始」：直接落在 `/chat/<chatId>`，右栏已是模板站点，对话里有一条「从模板「山间咖啡」开始」，首轮结束至少产出 v1；刷新后仍在同一会话。
- 输入框附近找不到「先规划」按钮，请求体里也不再出现 `plan`；输入含「先规划」的话仍得到方案卡与批准/改一改/拒绝，批准后继续跑。
- 折叠收起时只显示一行状态（如 `已完成 · 24 步 · 4 秒`），任务卡与工具组都看不见；展开后可见；AI 消息左侧没有 logo 头像；最终回复始终在折叠体外。
- 侧栏点「项目 / 对话 / 技能 / 模板」都不整页跳走且侧栏保留；任意时刻只有一个高亮；「对话」列出全部会话，点其中一条进入对应会话且高亮只剩那一条。
- `tsc --noEmit`、`eslint src`、`vitest run`、`npm run format:check`、`npm run build` 全绿；附一段 GIF 依次演示上述四件事。

## Assumptions

- 模板首版直接用 `buildSite()` 的模板产物落为 v1，不调用模型、不花一轮步数；用户之后每轮再迭代。
- 模板首轮自动开始（你选的 1a），所以进入对话页时是「生成中」状态，可随时点停止。
- 「对话」历史面板与「技能」面板都渲染在现有三栏壳内（中栏替换当前会话内容），不新开路由；`/skills` 仅保留为重定向。
- 折叠头在生成中自动展开、结束后自动收起；方案审批卡因为带按钮，始终留在折叠体外。
