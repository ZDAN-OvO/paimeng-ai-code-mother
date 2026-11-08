# v0 交互对齐验收证据（2026-11-08）

运行版本：分支 `feat/frontend-from-prototype` 工作区，`npm run dev` + mock 后端（`src/mock`），无数据库、无沙箱、无模型调用。数据为 `data/mock/state.json` 重新播种后的种子内容。

注意：这一轮之后首页与模板入口改成先建**草稿**，所以模板起聊的截图里顶栏显示「草稿 · 创建项目」；草稿转正的证据见 [../draft-to-project/](../draft-to-project/)。

- [walkthrough.gif](walkthrough.gif)（1.5 MB，25 秒）
- [walkthrough.webm](walkthrough.webm)（525 KB）
- 逐帧原图：[steps/](steps/)（16 张，1280×800）

GIF 由这 16 张逐步截图按停留时长合成；拖拽段（`009`–`014`）是真实鼠标输入 `Input.dispatchMouseEvent` 连续抓帧，不是补间。

## 每张图对应的状态

| 文件                       | 状态                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `000-home`                 | 首页，模板画廊在下方                                                                                                                      |
| `001-template-preview`     | 点模板卡后的整页预览，「用这个模板开始」在右上                                                                                            |
| `002-chat-templated-start` | 点完直接落到 `/chat/<id>`：顶部「从模板「咖啡馆官网」开始」，本轮到 `生成中`，右栏已是模板站点，侧栏项目树只有一个会话高亮                |
| `003-chat-collapsed`       | 本轮结束：折叠栏只剩 `已完成 · 19 步 · 3 秒`，任务卡与工具组都不见了，只有最终回复在外面；AI 消息没有 logo 头像；输入框一带没有「先规划」 |
| `004-chat-expanded`        | 点开折叠栏：任务卡 3/3、工具调用 18 步、思考都在折叠体内                                                                                  |
| `005-view-chats`           | 点侧栏「对话」：URL 仍是 `/chat/<id>`，中栏变成全部会话（按项目分组），右栏预览收起                                                       |
| `006-view-skills`          | 点「技能」：技能页内容搬进中栏，「去 Chat 验证技能」不再是整页跳转                                                                        |
| `007-view-templates`       | 点「模板」：模板画廊在中栏，选一个即建项目                                                                                                |
| `008-view-projects`        | 点「项目」：项目卡片（缩略图、会话数、版本数、发布地址）                                                                                  |
| `009`–`014-drag-*`         | 按住侧栏右缘拖动：264 → 280/300/320/340/360/380，中栏同步变窄                                                                             |
| `015-drag-done`            | 松手后宽度停在 380，侧栏仍展开；双击回到 264（写 `paimeng.sidebarPx`）                                                                    |

## 同时用 cURL 验证过

- `POST /api/projects` 带 `templateId: coffee`：响应后立即 `GET /api/chats/<id>` 就有 `v1`（`messageId: null`，summary `模板「咖啡馆官网」的初始版本`，10 个文件），首轮结束后追加 `v2`。
- `POST /api/chats/<id>/messages` 的请求体只剩 `{ text, attachments }`（浏览器侧拦截 `window.fetch` 记录），不再出现 `plan`。
- 输入「先规划一下…」仍产出方案卡与批准/拒绝，请求体同样没有 `plan`。
- 侧栏同一时刻只有一个 `.font-medium` 激活项：会话视图是项目树里的那条，「对话/技能/模板/项目」视图各自只有一个。

## 未覆盖

- 模板首轮的 `生成中` 只在 `002` 抓到一帧；流式过程本身沿用上一轮证据（`docs/evidence/frontend-from-prototype/`）。
- 没有真实后端：`/api/**` 仍是 `src/mock` 的实现；发布仍是本地渲染 `MockSite`。
