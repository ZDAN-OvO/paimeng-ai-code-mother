# 项目概览与会话归档 验收证据（2026-11-08）

运行版本：分支 `feat/frontend-from-prototype` 工作区，`npm run dev` + mock 后端，`data/mock/state.json` 重新播种（3 个项目 + 2 条种子草稿）。

- [walkthrough.gif](walkthrough.gif)（492 KB，24 秒）
- [walkthrough.webm](walkthrough.webm)（143 KB）
- 原图：[steps/](steps/)（9 张，1280×800）

## 每张图的状态

| 文件                        | 状态                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `000-chat-sidebar`          | 对话页：侧栏项目树 + 草稿 + 收藏；会话行悬停出「⋯」                                                                             |
| `001-chat-row-menu`         | 会话行的「⋯」展开：重命名 / 归档（没有删除）                                                                                    |
| `002-overview-deployed`     | 点侧栏「山间咖啡」：中栏变项目概览——部署卡 `已上线 · cafe-8f2a · v3 · 11/06 09:15` + 「打开地址」，最近对话 1 条 + 「查看全部」 |
| `003-overview-menu`         | 概览右上「⋯」：重命名项目 / 环境变量 / 打开已发布地址                                                                           |
| `004-overview-empty-deploy` | 换成没有发布过的「周报面板」：部署区是空态「还没有发布过」+「去对话里发布」，最近对话仍在                                       |
| `005-archived-toast`        | 在草稿「指针 AI 落地页」上点「归档」：toast「已归档 · 在「对话 → 归档」里可以找回它」                                           |
| `006-archived-list`         | 「对话 → 归档」：1 条归档会话，显示归档时间与「恢复」，右上「回到列表」                                                         |
| `007-restored`              | 点「恢复」后归档列表清空，草稿重新出现在侧栏                                                                                    |
| `008-rename-inline`         | 会话行「⋯ → 重命名」：就地输入框，回车保存                                                                                      |

## cURL 验证过的接口

- `POST /api/chats/:id/archive` → 返回 `ChatSummary`，`archivedAt` 有值；该会话从 `GET /api/drafts`、`/api/projects/:id/chats`、`/api/chats?archived=1` 之外的默认列表消失。
- 生成中的会话归档 → `409`（先停止再归档）。
- `POST /api/chats/:id/restore` → `archivedAt: null`，会话回到原列表。
- `GET /api/chats?archived=1` → 只返回归档会话，按归档时间倒序。
- `PATCH /api/chats/:id { title }` → 草稿与项目会话都能改名，侧栏与顶栏立刻更新。
- `DELETE /api/chats/:id` 已从契约移除；界面上没有任何永久删除入口。

## 未覆盖

- 概览的「环境变量」复用对话页右栏的设置面板（先打开该项目最近一条对话再切面板），没有为概览单独做环境变量页。
- 归档不影响版本与发布地址：已发布项目的对话归档后，`/deploys/<key>` 仍然可访问；这条用接口确认，未单独截图。
