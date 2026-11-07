# 前端工程化验收证据（2026-11-07）

录制版本：`frontend-from-prototype` 分支工作区，mock 后端（`src/mock`），无数据库、无沙箱、无模型调用。

- [walkthrough.gif](walkthrough.gif)（977 KB，48 秒，8 fps）
- [walkthrough.webm](walkthrough.webm)（1.1 MB，原始视频）

## 这段录屏演示的状态

1. 首页 `/` 加载项目列表、模板画廊与模型选择。
2. 输入一句话后创建项目：`POST /api/projects` 建 Project 与首个 Chat，并立即开始首轮。
3. 跳到 `/chat/<chatId>`，订阅 `GET /api/chats/:id/events`：Todo 从 0/3 走到 3/3，工具卡片按 `part-added` 逐条出现，右栏预览随 `preview` 事件换成生成结果，期间显示「生成中」。
4. 本轮结束：`finish` 事件带版本号，消息折叠为「已完成 · 24 步」，左栏仍显示该对话。
5. 点「发布」：`POST /api/projects/:id/deploys` 后订阅 `GET /api/deploys/:id/events`，五个构建步骤逐个从「进行中」变「完成」，拿到 `deployKey`。
6. 打开 `/deploys/<deployKey>`：渲染该版本的站点，右下角标注版本与「由 Paimeng 发布」。

## 同时验证过的接口（cURL，未录屏）

- `POST /api/chats/:id/messages` 带 `attachments` 与 `selection`：本轮出现 `image`、`selection` 片段，工具包含 `read_attachment`，并读取 `components/header.tsx:5`。
- 输入含「八项工具」：出现 `read_file`、`write_file`、`edit_file`、`glob_files`、`grep_files`、`move_file`、`delete_file`、`run_command`。
- 输入含「执行上限」：`finish.status = budget_exhausted`，Todo 未全部完成。
- `POST /api/chats/:id/plans/:messageId`：批准后开始新一轮并追加版本；拒绝只改方案状态。
- `GET /api/chats/:id/versions/:versionId/diff` 与 `POST .../rollback`：diff 返回按文件的新增/删除行数，回滚追加 `v4 · 回滚到 v1`。
- `PUT /api/projects/:id/env`：整表覆盖并返回项目。
- 重启 `next dev` 后 `data/mock/state.json` 仍在，已发布地址与项目列表不变。

## 未覆盖

- 移动端布局、真实沙箱预览、真实构建产物：mock 阶段不做，接口形状已由 `docs/api.md` 固定。
- 录屏只演示正常一轮；修复、失败、旧证据、未信任脚本四种剧情用上面的 cURL 验证，未单独录制。
