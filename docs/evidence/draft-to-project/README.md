# 草稿 → 项目 验收证据（2026-11-08）

运行版本：分支 `feat/frontend-from-prototype` 工作区，`npm run dev` + mock 后端，`data/mock/state.json` 重新播种（3 个项目 + 2 条种子草稿）。

- [walkthrough.gif](walkthrough.gif)（365 KB，14 秒）
- [walkthrough.webm](walkthrough.webm)（113 KB）
- 原图：[steps/](steps/)（5 张，1280×800）

## 每张图的状态

| 文件                  | 状态                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `000-draft-running`   | 首页输入一句话后直接落到 `/chat/<id>`，顶栏是「草稿」徽标 + 「创建项目」，侧栏「草稿」里有这一条，右栏已经是生成的站点                         |
| `001-draft-done`      | 首轮结束：折叠栏收起，预览在，草稿列表三条（新建的 + 两条种子），项目区列出 3 个已有项目（草稿态也能看到项目）                                 |
| `002-became-project`  | 点「创建项目」：toast「已创建项目…现在可以用「发布」把它部署出去」，按钮变「发布」，草稿列表少一条，项目树多出同名项目且当前会话高亮，URL 不变 |
| `003-open-seed-draft` | 点侧栏种子草稿「指针 AI 落地页」：直接进 `/chat/chat_draft_pointer` 草稿态，不再跳首页塞提示词                                                 |
| `004-history`         | 「对话」视图：所有会话按项目分组，草稿会话也在其中                                                                                             |

## cURL 验证过的接口

- `POST /api/chats` `{prompt, templateId}` → `201 {chat, eventsUrl}`，`chat.projectId` 为 `null`，`chat.draft = {prompt, templateId}`；带显式模板时首轮之外还有 `v1`（模板产物，`messageId: null`）。
- `GET /api/drafts` → 只返回 `projectId === null` 的会话，按更新时间倒序。
- `POST /api/chats/:id/project` → `201 {project, chat}`：项目名/描述/模板来自草稿；会话与版本原地保留；对已是项目的会话重复调用返回 `409`。
- `DELETE /api/chats/:id` → 草稿 `204`；项目里的对话 `409`。
- 转正后 `POST /api/projects/:id/deploys` 照旧更新为 `deployKey site-47xsil`、`state: ready`，`/deploys/site-47xsil` 返回 200。

## 未覆盖

- 创建项目后不自动部署（按你的要求）；要上线仍需点「发布」。
- 草稿没有环境变量与发布记录：右栏「设置」「产物」在草稿态显示说明文字，不渲染空表。
