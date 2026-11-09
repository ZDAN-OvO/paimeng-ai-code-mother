# Review subagent 审查轮次 界面证据（2026-11-09）

运行版本：分支 `feat/frontend-from-prototype` 提交 `a496fe6`（录制时为同内容的未提交工作区），`next build` + `next start -p 3210`，mock 后端。dev server 下 mock 写 `data/mock/state.json` 会触发热重载、页面反复刷新，所以用生产构建录。

这是 mock 演出，证明契约形状与界面形态：审查结论、打回理由、修订指纹都是 `src/mock/scenario.ts` 写好的固定剧情，review subagent 与 CI 都没有真实运行，不点亮 2.1 的任何一条。

- [walkthrough.gif](walkthrough.gif)（4.7 MB，12 秒）
- [walkthrough.webm](walkthrough.webm)（3.1 MB）
- 原图：[steps/](steps/)（4 张，1280×800）

## 每张图的状态

| 文件                             | 状态                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `000-code-review-rejected`       | 首轮「大改动请走审查」：写完文件后 `run_checks` 通过，Code review 第 1 轮打回，列出两条理由；修复后再跑 CI，第 2 轮审查中，修订指纹已变      |
| `001-completion-review-rejected` | Code review 第 2 轮通过；Completion review 第 1 轮打回「营业时间没有出现在页面上」，补上后再跑 CI，第 2 轮通过                               |
| `002-finished-reviewed-expanded` | 本轮结束，折叠头显示「审查 4 次 · 打回 2 次」；展开后审查卡按发生顺序夹在工具调用之间                                                        |
| `003-small-change-unreviewed`    | 第二轮「把按钮文案改成「立即预订」」：主 agent 按小改动处理，只跑 CI、没调完成审查；状态是已完成，页脚有「未经完成审查」标记，预览按钮已更新 |

## 接口验证过的路径

用 `curl` 跟 `GET /api/chats/:id/events` 的 SSE，逐条确认：

- 审查路径：`review` 片段 code#1 `changes_requested` → `edit_file` → `run_checks` → code#2 `passed` → completion#1 `changes_requested` → completion#2 `passed`；`finish.completionReviewed = true`。
- 小改动：只有 `run_checks`，没有 `review` 片段；`finish.status = succeeded`，`completionReviewed = false`。
- 证据过期：CI 通过后又写文件，completion review 片段 `state: error`，理由「当前修订没有 CI 通过记录，审查没有开始」；重跑 CI 后再审通过。
- 失败：`run_checks` 出错，`finish.status = failed`，`completionReviewed = false`。
- `GET /api/chats/:id` 的消息上带同样的 `completionReviewed`，刷新后标记不丢。

## 未覆盖

- 被停止时运行中的审查标成「没有结论」，只有单元测试（`src/mock/flow.test.ts`），没录屏。
- 证据过期路径只用接口确认，没截图。
