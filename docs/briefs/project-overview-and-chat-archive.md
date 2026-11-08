# Brief: 项目概览页与会话归档

- Stage: execute
- Source: 用户两条反馈：点项目要能看到部署情况与项目内对话（参考 v0 的 Projects > emporium 概览）；草稿和项目下的对话要能改名与「归档」，不是删除，归档后还能在对话页看到并恢复。

## Goal

- 点侧栏项目名或项目卡片，中栏变成项目概览：部署现状、最近对话、项目级操作菜单，不再直接跳进某条会话。
- 会话（草稿与项目内同一个能力）可以重命名、归档；归档是唯一的「收拾掉」手段，界面不提供永久删除。
- 归档的会话从所有默认列表消失，但能在一个「归档」入口里找到并恢复，方便用户确认自己没有丢东西。

## Context

- 现有侧栏「项目」行点击只做展开/收起，`项目` 视图里的卡片点击直接进 `lastChatId`，没有项目级页面。
- `Project` 已带 `deployKey` 与 `deploys[]`（含 `state`、`versionSeq`、`createdAt`），部署事件流已有；概览所需的部署信息不用新接口。
- `PATCH /api/chats/:id` 已支持改 `title`，但界面没有任何入口；草稿目前只有悬停出现的 🗑，调 `DELETE /api/chats/:id`。
- 工作区用 `view: chat | chats | projects | skills | templates` 切中栏，不换路由；「对话」视图已按项目分组列出全部会话。
- 归档在数据里还不存在：`ChatSummary` 没有相关字段，mock 也没有归档逻辑。

## Materials

- 截图（`/tmp/`）：`pi-clipboard-63a267e2…png`（v0 项目概览：Production Deployment + Recent Chats）、`pi-clipboard-a722739f…png`（项目概览的「…」菜单）、`pi-clipboard-36572b7c…png`（草稿行悬停的时间 + ⋯）、`pi-clipboard-454fe13d…png`（v0 对话列表与 Archived Chats 入口）、`pi-clipboard-8afa6916…png`（Archive 页与 Restore）。
- 主要改动面：`src/features/workspace/{workspace,app-sidebar,projects-panel,chat-history-panel}.tsx`、`src/shared/api/schemas.ts`、`src/mock/world.ts`、新增项目概览组件。
- 接口参照：`src/app/api/chats/[id]/route.ts`（PATCH 已存在）、`src/app/api/drafts/route.ts`、`src/app/api/projects/[id]/chats/route.ts`。
- 只看这些文件与其直接依赖；不扩到 `src/server/**`、`migrations/`、`archive/`。缺数据时留空态文案，不编造部署记录。

## Boundaries

- 归档不是删除：界面不出现「永久删除」，`DELETE /api/chats/:id` 从契约里移除，由 `POST /api/chats/:id/archive` 与 `POST /api/chats/:id/restore` 取代。
- 不改草稿→项目流程、发布流程与部署接口；概览里的部署区只读现状，重新发布仍走右上「发布」。
- 不新增路由（不加 `/projects/<id>`），仍用工作区中栏视图；同一时刻侧栏只有一个高亮。
- 归档不影响版本、发布地址与已部署状态；已归档会话不能被当作「当前会话」继续展示在默认列表里。
- 不动 `docs/architecture.md` §3 模块边界，不引入新依赖。

## Done

- 侧栏点项目名：中栏显示概览——部署卡（有部署时给 `deployKey`、版本号、状态、时间与「打开地址」；没有部署时给空态与「发布」引导）、最近对话（按更新时间最多 5 条，点进对话）、「查看全部」跳到该项目的对话列表。
- 项目卡片的点击行为与侧栏项目名一致；概览右上「⋯」有重命名项目、环境变量、打开已发布地址（无 `deployKey` 时禁用）。
- 侧栏草稿行与会话行的「⋯」菜单都有：重命名（就地输入，回车保存）、归档；原来的 🗑 删除入口消失。
- 归档后该会话从侧栏草稿/项目树、概览最近对话、`对话` 默认列表消失；`对话` 视图有「归档」入口，列出归档会话并可「恢复」，恢复后回到原位置；归档的正好是当前会话时跳到最近一条未归档会话，没有就回首页。
- `tsc --noEmit`、`eslint src`、`vitest run`、`npm run format:check`、`npm run build` 全绿；附一段 GIF 演示概览、改名、归档、恢复。

## Assumptions

- 归档字段用 `archivedAt: string | null`（ISO 时间），归档时间只用于排序与展示，不生成新版本。
- 概览的「最近对话」取该项目下未归档会话的前 5 条；「查看全部」复用现有 `对话` 视图并带上项目过滤。
- 重命名走已有的 `PATCH /api/chats/:id`，草稿与项目会话共用同一入口；项目名重命名继续用 `PATCH /api/projects/:id`。
- `GET /api/drafts` 与项目会话列表默认排除归档项，`GET /api/chats?archived=1`（或等价端点）返回归档列表。
