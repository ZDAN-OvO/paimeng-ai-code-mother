# Paimeng Studio 架构

本文件是新产品的唯一架构总述。细节决策记在 `docs/adr/`，代码结构以本文件与代码为准，不在别处重复。

## 1. 产品定位

开源版的 v0：用户在浏览器里描述想要的界面或应用，系统生成一个完整的 Next.js 项目，在沙箱里实时预览，通过对话迭代，按版本回滚，最后发布成一个可访问的地址。

不是 SaaS 复刻。没有计费、团队、邀请、Figma 导入、第三方部署集成。单用户本地优先，`docker compose up` 之后就能用。

## 2. 交付范围（13 条验收契约）

每条以「能在浏览器里演示的路径」为完成标准，不以百分比衡量。

| # | 能力 | 演示路径 |
| --- | --- | --- |
| 1 | 一句话建项目 | 首页输入描述，创建 Project 与首个 Chat |
| 2 | 流式对话 | 发送后逐字出现，工具调用有状态 |
| 3 | 生成完整 Next.js + Tailwind + shadcn 项目 | 沙箱里出现多文件项目并通过构建 |
| 4 | 代码面板 | 文件树、语法高亮、只读查看 |
| 5 | 沙箱内实时预览 | 保存即可见，刷新不丢 |
| 6 | 多轮迭代 | 同一 Chat 连续修改，文件真实变化 |
| 7 | 版本、diff、回滚 | 每条助手消息一个版本；可看 diff；回滚追加新版本 |
| 8 | 发布 | 得到 `/p/<deployKey>` 可访问地址，回滚后可重新发布 |
| 9 | Design mode 元素选择 | 点选预览元素，生成一句指向该组件的对话输入 |
| 10 | 截图导入 | 上传截图，作为视觉参考进入本轮生成 |
| 11 | 模板 | 新建时可选内置起始模板 |
| 12 | 浏览器与联网搜索 | 抓取网页正文、调用可配置搜索 API |
| 13 | 环境变量面板 | 为 Project 配置环境变量，沙箱与发布实例都注入 |

明确不做：多人协作与邀请、Figma 导入、Vercel 一键部署、GitHub PR 导出、数据连接向导、计费与额度、组件市场、移动端 App、公开模板画廊。

## 3. 技术栈

- Next.js（App Router）+ React + TypeScript，代码位于仓库根目录。
- Tailwind CSS + shadcn/ui。布局与交互对齐 v0，视觉用 shadcn 默认。
- Vercel AI SDK 7，agent 用 `ToolLoopAgent`。
- PostgreSQL + Drizzle ORM，迁移为编号 SQL。
- Docker：开发沙箱与发布实例共用一套镜像与产物流程。

## 4. 关键决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D1 | 旧应用整体归档，新代码落在仓库根 | 旧架构被 pi-durable 的假设塑形，重构成本高于重建 |
| D2 | 零代码复用 | 旧 schema 压着计费与配额，带进来会把复刻拖成计费系统复刻 |
| D3 | `ToolLoopAgent` 承载循环 | 循环、多步、工具、流式都是 SDK 已有的能力 |
| D4 | 不做 durable execution | 中断即失败并重试；Workflow DevKit 是上一轮返工的来源 |
| D5 | 沙箱实现 SDK 的 `SandboxSession` 接口 | 沙箱直接接入 agent 工具上下文，不另造一层 |
| D6 | 每个 Chat 一个常驻容器 | 文件系统按 Chat 持久；空闲 30 分钟回收，硬顶 24 小时 |
| D7 | 沙箱默认禁出站，只放行 npm registry | 生成代码不可信；需要联网时按技能临时放行 |
| D8 | 预览用 `next dev` 加反向代理 | 迭代必须改完即见；`build` 的分钟级等待不可接受 |
| D9 | 版本是源码树快照 | 文件级 diff 与回滚只需两棵树比对，不引入 git 推送语义 |
| D10 | 发布用通用 runner 镜像挂载产物 | 不为每个应用构建镜像，也不需要本地 registry |
| D11 | 技能是带 frontmatter 的目录 | `SKILL.md`、`references/`、`scripts/`，与 Claude Code 同构 |
| D12 | 技能路由由生成模型自己做 | 描述进 system prompt，正文靠 `load_skill` 工具按需加载 |
| D13 | 技能描述全量列出，不设上限 | 一行一条，五十条约一千多 token |
| D14 | 用户技能落盘，脚本在沙箱内执行 | 正文由服务进程读，脚本只读挂载进沙箱，导入时显式信任 |
| D15 | 单用户本地优先 | clone 下来就能跑；所有表带 `user_id`，多用户是后续 PR |
| D16 | Project → Chat → Version 三层 | 与 v0 同构，发布挂在 Project 上 |
| D17 | 模型配置在 `config/providers.json` | 密钥走环境变量，永不入库 |
| D18 | 单实例部署 | 沙箱与预览代理都在同一进程拓扑内，横向扩展不在范围内 |

## 5. 数据模型

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `project` | 一次产品，对应一个发布地址 | `id`、`user_id`、`name`、`env jsonb` |
| `chat` | 一条对话线，属于 Project | `id`、`project_id`、`model_id`、`title` |
| `message` | 对话消息，AI SDK `UIMessage` 的 parts | `id`、`chat_id`、`seq`、`role`、`parts jsonb` |
| `version` | 一条助手消息对应的源码快照 | `id`、`chat_id`、`message_id`、`seq`、`snapshot_path` |
| `skill` | 技能索引，正文在磁盘 | `id`、`owner_id`、`slug`、`description`、`source`、`trusted` |
| `deploy` | 一次发布 | `id`、`project_id`、`version_id`、`deploy_key`、`state` |
| `sandbox_session` | 沙箱容器与工作区 | `id`、`chat_id`、`container_id`、`volume`、`expires_at` |

内置模板与内置技能直接扫描 `templates/` 与 `skills/`，不建表。用户技能的正文与文件在 `data/users/<userId>/skills/<slug>/`，表里只存索引。

## 6. 模块边界

```
/
├── src/app/                 # 页面与 HTTP 入口：项目、对话、预览代理、发布
├── src/server/agent/        # ToolLoopAgent、工具定义、技能加载与路由
├── src/server/sandbox/      # SandboxSession 的 Docker 实现、生命周期与回收
├── src/server/preview/      # 反向代理、HMR WebSocket、域名与路由
├── src/server/publish/      # 构建产物、runner 容器、deployKey 路由
├── src/server/versioning/   # 快照、diff、回滚
├── src/server/model/        # providers.json 读取、模型解析
├── src/server/db/           # Drizzle schema 与迁移
├── skills/                  # 内置技能，每个一个目录
├── templates/               # 内置起始项目
├── config/providers.json    # 模型清单，密钥用环境变量名
└── docs/                    # 架构与 ADR
```

业务逻辑只在 `src/server/**`；`src/app` 只做路由与渲染，不写领域规则。

## 7. 技能系统

目录格式与 Claude Code 一致：

```
skills/<slug>/
├── SKILL.md          # frontmatter: name, description；正文是完整指令
├── references/       # 按需读取的参考文件
└── scripts/          # 需要时在沙箱内执行
```

- 启动时扫描内置与当前用户的技能目录，生成索引。
- system prompt 只放 `name` 与 `description`，全量列出。
- 模型调用 `load_skill(slug)` 获取正文；`read_skill_file(slug, path)` 读 references。
- 用户技能导入时展示文件清单，要求显式勾选信任；未信任的技能脚本不执行。
- `skill-creator` 是内置技能，通过受控的 `create_skill` 工具写入用户技能目录，落盘前校验 slug、路径与大小。

## 8. 沙箱与预览

`sandbox/src/docker.ts` 实现 AI SDK 的 `SandboxSession`：`readTextFile`、`writeTextFile`、`listDirectory`、`stat`、`deleteFile`、`run`、`spawn`。

- 每个 Chat 一个容器，工作区是命名卷，挂在 `/workspace`。
- 容器参数沿用旧库验证过的隔离：`--read-only`、`--cap-drop=ALL`、`--pids-limit`、`--memory`、`--cpus`、`--security-opt=no-new-privileges`。
- 网络默认 `--network=none`；安装依赖时临时接入受限网络，只允许 registry。
- 预览：容器内 `next dev` 监听 3000，宿主机反向代理 `/preview/<chatId>/*`，并代理 HMR 的 WebSocket。
- 生命周期：空闲 30 分钟回收；最后一次活动起 24 小时硬顶；回收后从快照恢复工作区。

## 9. 发布

1. 沙箱内 `next build`，产物在 `.next/standalone`。
2. 把 standalone、`public`、必要静态资源复制到 `data/deploys/<projectId>/<deployId>/`。
3. 用通用 runner 镜像启动只读容器，环境变量取自 `project.env`。
4. 网关按 `/p/<deployKey>` 反代到 runner 容器；回滚等于切换软链并重启容器。

## 10. 版本、diff 与回滚

- 每条助手消息结束后，把工作区源码树快照到 `data/versions/<chatId>/<versionSeq>/`，排除 `node_modules`、`.next`、`.git`。
- diff 在服务端比对两棵树，按文件输出新增、删除、修改。
- 回滚把旧快照写回工作区，并追加一个新版本，历史保持线性。

## 11. 交付顺序

垂直切片，每一步都先能演示再往下走。

1. 骨架：根目录 Next.js、Drizzle、健康检查、CI。
2. 沙箱：Docker `SandboxSession`、预览代理、模板项目能跑起来。
3. 生成闭环：`ToolLoopAgent`、文件工具、流式、消息持久化（验收 1、2、3、5、6）。
4. 代码面板与版本（验收 4、7）。
5. 技能系统与 `skill-creator`。
6. 发布（验收 8）。
7. Design mode 与截图导入（验收 9、10）。
8. 搜索、模板、环境变量面板（验收 11、12、13）。

每个 PR 附浏览器录屏（GIF）、数据库行与沙箱真实输出，证据放 `runtime/evidence/`。

## 12. 未决与风险

- AI SDK 7 的 `experimental_sandbox` 接入点需要在第二个切片里实测确认：挂在 agent 设置上，还是挂在工具执行上下文里。
- `next dev` 反向代理要处理绝对路径、HMR WebSocket 与子路径 basePath，先做 spike。
- 预览与发布共用镜像，需要确认 standalone 产物在 runner 里对静态资源与 API route 都成立。
- 快照体积随项目增长，需要保留策略（例如只保留最近 N 个版本）。
