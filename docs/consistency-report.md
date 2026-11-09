# 文档与代码一致性差异清单（2026-11-08）

检查点 ① 的产物。只报告，不改任何文档；每条等你裁决后再动。

**2026-11-08 收尾：全部条目已裁决为「全收」，修订已应用到 `architecture.md`、`api.md`、`mvp.md`、`GLOSSARY.md`；L7 销案。本文件可留作记录，也可在检查点 ② 开工前删掉。**

核对对象：`docs/mvp.md`、`docs/architecture.md`、`docs/api.md`、`src/shared/api/schemas.ts`、`src/app/api/**`（27 个 route handler）、`src/features/**`、`migrations/001_init.sql`、`src/server/db/schema.ts`、`GLOSSARY.md`、`PRODUCT.md`、`docs/briefs/**`、`.github/workflows/tests.yml`。

核对方式：静态对照。前端是 mock（`src/app/api/**` 全读 `src/mock/world.ts`，数据落 `data/mock/state.json`），跑起来只能证明 mock 自洽，所以本轮没有起 dev server。

分类口径：① 文档滞后 ② 未交付（进度，不算差异）③ 真冲突。

## ③ 真冲突

### A. 契约与表结构对同一件事给了相反规则

| #   | 冲突                                                 | 证据                                                                                                                                                                                                               | 影响文件                            |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| A1  | 草稿能不能没有项目：契约说「能」，表说「不能」       | `schemas.ts:150` 的 `projectId` 可空并注明「草稿没有项目」；`api.md` 的 `POST /api/chats` 写明 `chat.projectId` 为 `null`；`001_init.sql:8-15` 与 `db/schema.ts:22-24` 是 `project_id not null references project` | `architecture.md` 第 5 节、迁移 002 |
| A2  | 归档字段：接口与类型有，表与架构文档都没有           | `schemas.ts:161` 有 `archivedAt`；`api/chats/[id]/archive/route.ts`、`restore/route.ts` 存在；`chat` 表无 `archived_at`，`architecture.md` 第 5 节 chat 关键列也没有                                               | `architecture.md` 第 5 节、迁移 002 |
| A3  | 「字段命名对齐 `src/server/db/schema.ts`」这句不成立 | 契约 `Project` 是 `id/name/prompt/templateId/createdAt/updatedAt/env/deployKey/deploys`（`schemas.ts:134-145`）；`project` 表是 `id/user_id/name/env/created_at`                                                   | `api.md` 开头、第 5 节              |

建议：在 `architecture.md` 第 5 节把三个概念写死 —— 草稿是 `project_id` 为空的 chat、归档是 `archived_at` 有值、Project 的 `prompt/templateId` 存在 `project` 表而不是 join 出来；`api.md` 里「命名对齐 schema」的断言改成一张字段对照，否则它一直是个会悄悄变假的句子。

### B. 文档之间互相矛盾

| #   | 冲突                                                                                                                                                                                                               | 证据                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| B1  | 证据放哪：`architecture.md` 第 11 节末尾写「证据放 `runtime/evidence/`」；根 `AGENTS.md` 与仓库实际是 `docs/evidence/`；`runtime/` 不存在                                                                          | `architecture.md:239` 附近、`AGENTS.md` PR 证据节、`docs/evidence/` |
| B2  | 沙箱实现路径：第 8 节写 `sandbox/src/docker.ts`，第 6 节模块边界写 `src/server/sandbox/`，两处不同，实际都不存在                                                                                                   | `architecture.md` 第 6、8 节                                        |
| B3  | 权威链缺一层：`mvp.md:3` 说冲突时先改 mvp 的范围结论再同步架构；`architecture.md:5` 说代码结构以本文件与代码为准；`api.md` 开头说字段命名权威是 `schemas.ts`。三条各自成立，但 `api.md` 与 `mvp.md` 谁优先没有规则 | 三处开头                                                            |

建议：B1 统一到 `docs/evidence/`；B2 统一到 `src/server/sandbox/`；B3 在第 6 节补一行总链（范围看 mvp、结构与模块看 architecture、前后端字段看 schemas 与 api.md），谁改哪一份一目了然。

## ① 文档滞后

| #   | 滞后                                                          | 证据                                                                                                                                                          | 建议修订                                                        |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| L1  | `/api/health` 没进契约，而 M0 的退出条件就是它                | `src/app/api/health/route.ts` 真查数据库并在失败时返回 503；`mvp.md` 第 6 节 M0 行                                                                            | `api.md` 补一行                                                 |
| L2  | `GET /api/chats` 不带参数返回空列表，契约只写了 `?archived=1` | `src/app/api/chats/route.ts:11`                                                                                                                               | `api.md` 补默认行为，或删掉这段兜底                             |
| L3  | mock 进度与里程碑落差不解释                                   | `docs/evidence/` 五份录屏已覆盖 4、5、6、7、9、10、13 的界面；里程碑把它们排在 M3、M5、M6、M7                                                                 | 第 6 节加一句口径：mock 已演示不计入交付                        |
| L4  | 两份文档的「明确不做」清单不同步                              | `mvp.md` 第 3 节比 `architecture.md` 第 2 节多四类：用户发布模板、动态 ToolSearch、独立任务管理平台、通用制品平台与图片生成                                   | 统一到 mvp，architecture 引用它                                 |
| L5  | 数据模型关键列不全                                            | `skill.enabled`、`deploy.artifact_path`、`sandbox_session.last_active_at` 都在表里，架构没列                                                                  | 第 5 节补齐                                                     |
| L6  | `GLOSSARY.md` 的 Template 说「新建 Project 时可以选择」       | 实际是新建 Draft 时选，转正带过去（`api.md` 的草稿段与 `draft.templateId`）                                                                                   | 改成「新建 Draft 时选择，转正时带入 Project」                   |
| L7  | 历史 brief 的备注容易被读成「草稿不再跑首轮」                 | `docs/briefs/v0-interaction-alignment.md:3` 说的是不自动部署；`mvp.md:19` 的「建 Draft 并跑首轮」与实现一致（`api/chats/route.ts` 建草稿后立刻 `startRound`） | 不必改 mvp；在 brief 备注里补一句「仍跑首轮」，或在本报告里销案 |

L7 是我上一轮读错的：我把「不自动部署」读成了「不跑首轮」，并据此说 `mvp.md` 滞后。核对后 `mvp.md` 与实现一致，撤回那条判断。

## ② 未交付（不算差异，只登记）

- 技术栈里的 AI SDK 7 与 `ToolLoopAgent` 不在 `package.json`；当前没有模型调用。
- 第 6 节列出的 `src/server/{agent,sandbox,preview,publish,versioning,model}` 六个目录不存在，只有 `db`。
- `config/providers.json`、`skills/`、`templates/` 三个路径都不存在；模型、模板与内置技能目前由 `src/mock/seed/` 顶着。
- 13 条里第 3（生成完整项目）、8（真实发布）、12（抓取与搜索）无任何实现；第 3、8 条只有 mock 剧情。
- 第 2.1 节的八项工具、Todo、Plan、验证与完成判定，全部是 mock 剧本（`src/mock/scenario.ts`），不是真实执行。
- 真实浏览器、沙箱、HMR 反代：零实现。

## 已核对一致（供复核，不需动作）

- 13 条在 `mvp.md` 第 2 节与 `architecture.md` 第 2 节逐字相同，里程碑列与第 6 节一致。
- 27 个 route handler 的方法与路径，与 `api.md` 的四张表逐条对得上（除 L1、L2）。
- 前端路由 `/`、`/chat/<chatId>`、`/skills`、`/deploys/<deployKey>` 与 `api.md` 的「前端路由」表一致。
- 前端调用点没有用到 `api.md` 之外的接口。
- `GLOSSARY.md` 的 Draft、Archive、Version、Snapshot 与 `api.md` 一致。
- M0 的退出条件成立：`compose.yaml` 起 Postgres，`/api/health` 查库并区分 200 与 503。

## 待你裁决

L1–L6 与 A1–A3、B1–B3 各自给一条修订建议。逐条说保留、改写或丢掉，我再动文档；L7 建议销案。

裁决结果（2026-11-08）：全部保留并已应用。改动落在 `architecture.md`（第 2、5、6、8、11 节）、`api.md`（开头、约定后新增「契约与表结构」与「健康检查」、`GET /api/chats` 一行）、`mvp.md`（第 6 节一句、第 9 节变更）、`GLOSSARY.md`（Template）。未动代码与迁移。
