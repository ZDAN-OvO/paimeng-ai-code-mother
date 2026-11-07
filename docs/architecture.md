# Paimeng 架构

本文件是新产品的唯一架构总述。细节决策记在 `docs/adr/`，代码结构以本文件与代码为准，不在别处重复。

## 1. 产品定位

开源版的 v0：用户在浏览器里描述想要的界面或应用，系统生成一个完整的 Next.js 项目，在沙箱里实时预览，通过对话迭代，按版本回滚，最后发布成一个可访问的地址。

不是 SaaS 复刻。没有计费、团队、邀请、Figma 导入、第三方部署集成。单用户本地优先，`docker compose up` 之后就能用。

## 2. 交付范围（13 条验收契约）

每条以「能在浏览器里演示的路径」为完成标准，不以百分比衡量。

| #   | 能力                                      | 演示路径                                           |
| --- | ----------------------------------------- | -------------------------------------------------- |
| 1   | 一句话建项目                              | 首页输入描述，创建 Project 与首个 Chat             |
| 2   | 流式对话                                  | 发送后逐字出现，工具调用有状态                     |
| 3   | 生成完整 Next.js + Tailwind + shadcn 项目 | 沙箱里出现多文件项目并通过构建                     |
| 4   | 代码面板                                  | 文件树、语法高亮、只读查看                         |
| 5   | 沙箱内实时预览                            | 保存即可见，刷新不丢                               |
| 6   | 多轮迭代                                  | 同一 Chat 连续修改，文件真实变化                   |
| 7   | 版本、diff、回滚                          | 每条助手消息一个版本；可看 diff；回滚追加新版本    |
| 8   | 发布                                      | 得到 `/p/<deployKey>` 可访问地址，回滚后可重新发布 |
| 9   | Design mode 元素选择                      | 点选预览元素，生成一句指向该组件的对话输入         |
| 10  | 截图导入                                  | 上传截图，作为视觉参考进入本轮生成                 |
| 11  | 模板                                      | 新建时可选内置起始模板                             |
| 12  | 浏览器与联网搜索                          | 抓取网页正文、调用可配置搜索 API                   |
| 13  | 环境变量面板                              | 为 Project 配置环境变量，沙箱与发布实例都注入      |

明确不做：多人协作与邀请、Figma 导入、Vercel 一键部署、GitHub PR 导出、数据连接向导、计费与额度、组件市场、移动端 App、公开模板画廊。

## 3. 技术栈

- Next.js（App Router）+ React + TypeScript，代码位于仓库根目录。
- Tailwind CSS + shadcn/ui。Paimeng 工作台的布局与交互对齐 v0，视觉用 shadcn 默认；生成项目的视觉方向由需求与设计 Skill 决定，不强制套用工作台外观。
- Vercel AI SDK 7，agent 用 `ToolLoopAgent`。
- PostgreSQL + Drizzle ORM，迁移为编号 SQL。
- Docker：开发沙箱与发布实例共用一套镜像与产物流程。

## 4. 关键决策

| 编号 | 决策                                  | 理由                                                                  |
| ---- | ------------------------------------- | --------------------------------------------------------------------- |
| D1   | 旧应用整体归档，新代码落在仓库根      | 旧架构被 pi-durable 的假设塑形，重构成本高于重建                      |
| D2   | 零代码复用                            | 旧 schema 压着计费与配额，带进来会把复刻拖成计费系统复刻              |
| D3   | `ToolLoopAgent` 承载循环              | 循环、多步、工具、流式都是 SDK 已有的能力                             |
| D4   | 不做 durable execution                | 中断即失败并重试；Workflow DevKit 是上一轮返工的来源                  |
| D5   | 沙箱实现 SDK 的 `SandboxSession` 接口 | 沙箱直接接入 agent 工具上下文，不另造一层                             |
| D6   | 每个 Chat 一个常驻容器                | 文件系统按 Chat 持久；空闲 30 分钟回收，硬顶 24 小时                  |
| D7   | 沙箱默认禁出站，只放行 npm registry   | 生成代码不可信；其他联网请求由宿主权限策略审批，加载 Skill 不自动放行 |
| D8   | 预览用 `next dev` 加反向代理          | 迭代必须改完即见；`build` 的分钟级等待不可接受                        |
| D9   | 版本是源码树快照                      | 文件级 diff 与回滚只需两棵树比对，不引入 git 推送语义                 |
| D10  | 发布用通用 runner 镜像挂载产物        | 不为每个应用构建镜像，也不需要本地 registry                           |
| D11  | 技能是带 frontmatter 的目录           | `SKILL.md`、`references/`、`scripts/`，与 Claude Code 同构            |
| D12  | 技能路由由生成模型自己做              | 描述进 system prompt，正文靠 `load_skill` 工具按需加载                |
| D13  | 技能描述全量列出，不设上限            | 一行一条，五十条约一千多 token                                        |
| D14  | 用户技能落盘，脚本在沙箱内执行        | 正文由服务进程读，脚本只读挂载进沙箱，导入时显式信任                  |
| D15  | 单用户本地优先                        | clone 下来就能跑；所有表带 `user_id`，多用户是后续 PR                 |
| D16  | Project → Chat → Version 三层         | 区分产品、对话线与源码历史，发布挂在 Project 上                       |
| D17  | 模型配置在 `config/providers.json`    | 密钥走环境变量，永不入库                                              |
| D18  | 单实例部署                            | 沙箱与预览代理都在同一进程拓扑内，横向扩展不在范围内                  |

## 5. 数据模型

| 表                | 作用                                  | 关键列                                                       |
| ----------------- | ------------------------------------- | ------------------------------------------------------------ |
| `project`         | 一次产品，对应一个发布地址            | `id`、`user_id`、`name`、`env jsonb`                         |
| `chat`            | 一条对话线，属于 Project              | `id`、`project_id`、`model_id`、`title`                      |
| `message`         | 对话消息，AI SDK `UIMessage` 的 parts | `id`、`chat_id`、`seq`、`role`、`parts jsonb`                |
| `version`         | 一条助手消息对应的源码快照            | `id`、`chat_id`、`message_id`、`seq`、`snapshot_path`        |
| `skill`           | 技能索引，正文在磁盘                  | `id`、`owner_id`、`slug`、`description`、`source`、`trusted` |
| `deploy`          | 一次发布                              | `id`、`project_id`、`version_id`、`deploy_key`、`state`      |
| `sandbox_session` | 沙箱容器与工作区                      | `id`、`chat_id`、`container_id`、`volume`、`expires_at`      |

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

### 6.1 单主 Agent 与反馈循环

`ToolLoopAgent` 承载同一个主 Agent 的分析、实现、检查与修复；Skill router 由该模型自己完成，不另设路由模型、Planner Agent 或检查 Agent。工具结果回到主 Agent，知识与验证程序不必各自调用模型。

| 层       | 责任                                                                | 不交给模型自行决定的事项           |
| -------- | ------------------------------------------------------------------- | ---------------------------------- |
| 宿主程序 | 权限、预算、消息与状态持久化、Sandbox 生命周期、Version、发布与回滚 | 是否允许越界动作、是否满足成功条件 |
| Tool     | 提供受控动作与真实结果                                              | 不承载完整任务策略，不扩大授权     |
| Skill    | 提供领域规范与工作方法                                              | 不授予工具权限，不自行批准通过     |

执行路径：读取实际项目与相关 Skill → 修改 Workspace → 验证工具 → **检查通过？**。失败时带回错误，由同一个 Agent 在剩余预算内修复；通过后调用完成判定工具 → **本轮目标满足？**。缺失项返回主 Agent，满足才允许宿主程序标记成功并保存、回复。工具是动作，两个问题是结果分支，不是额外 Agent。

- `verify_project` 执行规定检查，返回当前源码修订的检查结果、错误与证据引用。模型不能为了通过而削弱检查要求。
- `complete_task` 核对本轮结果与宿主保存的证据，接受完成或返回缺失项；它不是发布工具，也不宣称能用布尔规则完整验证自然语言需求。
- 检查证据绑定源码修订。写入、编辑、移动、复制或删除使受影响的旧证据失效，不能据此完成新修订。
- 模型结束工具调用、Todo 全部完成、达到最大步数均不等于任务成功。缺少证据时不得显示成功；预算允许时，把缺失项送回同一个 Agent。
- 检查失败、预算耗尽、取消与运行异常必须如实呈现并保留工作；中断仍按 D4 处理，不引入 durable execution。保存 Version 不代表本轮检查通过。
- 类型检查、构建与 HTTP 就绪检查各自只证明对应事实。构建通过或 HTTP 200 不证明视觉质量与交互正确；当前 HTTP 工具不承担真实浏览器验证。

### 6.2 工具边界

以下是待实现的工具契约，接口名用于规划，不声称与 v0 内部 schema 一致。八项文件与项目工具在 M2 一起交付，Move、Delete 不以 Bash 间接操作代替。

| Tool   | 规划接口      | 责任与限制                                                                   |
| ------ | ------------- | ---------------------------------------------------------------------------- |
| Read   | `read_file`   | 分段读取文件，限制大小并拦截秘密内容                                         |
| Write  | `write_file`  | 创建或覆盖文件；覆盖前读取并检查预期修订                                     |
| Edit   | `edit_file`   | 精确替换；拒绝过期内容与不唯一匹配                                           |
| Glob   | `glob_files`  | 按路径模式查找文件，限制范围与结果数量                                       |
| Grep   | `grep_files`  | 搜索内容，返回路径、行号与片段                                               |
| Move   | `move_file`   | 显式选择移动、重命名或复制文件及目录；默认拒绝覆盖目标                       |
| Delete | `delete_file` | 核对目标及预期修订；递归须显式声明，不隐式删除整个 Workspace                 |
| Bash   | `run_command` | 安装、构建、测试、脚本与本地 Git 命令；只在 Sandbox 内执行，有超时与输出限制 |

所有文件路径限定在当前 Chat 的 Workspace；源路径、目标路径与符号链接解析都要校验。目录枚举可保留 `list_files`，但不能替代 Glob 或 Grep。专用工具不是隔离边界，Bash 也必须遵守相同权限；允许本地 Git 不等于授权远端推送、合并或接入 GitHub 同步。

| 其他工具                            | 责任                                                                        | 阶段        |
| ----------------------------------- | --------------------------------------------------------------------------- | ----------- |
| `update_todos`                      | 创建与更新可见任务清单，不把勾选完成当作检查证据                            | M2          |
| `enter_plan_mode`、`exit_plan_mode` | 进入只读规划、提交计划并等待用户审阅                                        | M2          |
| `ask_user`                          | 澄清关键歧义；回答不等于批准实施方案                                        | M2          |
| `inspect_preview`                   | 查询就绪状态、预览地址与错误摘要，不负责浏览器操作                          | M2          |
| `verify_project`、`complete_task`   | 执行检查与完成判定，职责见 6.1                                              | M2          |
| `load_skill`、`read_skill_file`     | 按需读取正文、参考文件与脚本源码，读取不等于执行授权                        | M2 最小加载 |
| `create_skill`                      | 通过受控入口创建 User skill，校验路径、大小与重名                           | M4          |
| `fetch_url`、`search_web`           | HTTP 正文抓取与可配置搜索；校验网络目标、重定向与内网访问，密钥留在宿主环境 | M7          |

Sandbox 创建、开发服务器生命周期、密钥注入、消息落库与 Version 保存由宿主程序管理。发布与回滚走用户触发的产品接口，不默认暴露为 Agent 可自由调用的动作。Preview 不提供 logs 与 terminal 面板，不妨碍 Agent 读取受控的进程错误摘要。

### 6.3 Todo 与 Plan

Todo 表达执行进度，Plan 表达待审阅的方案；两者都是核心工具与产品状态，不是 Skill。多步骤工作展示 Todo；用户要求先规划或遇到重大范围变更时进入 Plan，小改动不强制先审批。

- Todo 使用 `pending`、`in_progress`、`completed`；失败或取消时保留实际进度，不把剩余项假报完成。
- Plan 期间允许读文件、搜索与读取 Skill；宿主程序禁用 Write、Edit、Move、Delete、通用 Bash、发布与 `create_skill`。
- `exit_plan_mode` 提交方案并暂停等待，不自动获批。用户可批准、要求修改或拒绝；分别进入执行、返回只读规划或停止本次实施。
- 批准只适用于提交的方案；方案改变使旧批准失效。获批后由同一个主 Agent 执行，不另起 Planner Agent。
- Todo、Plan 与审批决定保存在 Message 的结构化 parts 中，由宿主程序维护当前状态并推送 UI。持久化审批记录不代表进程重启后自动续跑。

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
- `skill-creator` 是内置技能，通过受控的 `create_skill` 工具写入用户技能目录，落盘前校验 slug、路径、大小与重名，不默认覆盖已有技能。
- 内置与用户 Skill 用稳定标识区分来源，避免同名覆盖。正文作为可追踪的工具结果追加，references 按需读取，不整目录注入或反复改写历史消息。
- 跨轮修改重新读取实际文件。Skill 提供知识，不提升权限；最低质量与安全要求始终属于系统指令，不能依赖模型碰巧加载某个 Skill。
- 信任状态由执行器校验；Trust 不扩大网络权限或宿主文件系统访问。只承诺目录与基础字段兼容，不默认支持其他运行时的全部扩展。

### 7.1 首批内置 Skill

| Skill              | 职责                                                 | 交付 |
| ------------------ | ---------------------------------------------------- | ---- |
| `frontend-design`  | 根据需求确定视觉方向、排版、tokens、响应式与交互状态 | M2   |
| `nextjs`           | 路由、组件边界、服务端逻辑与框架约束                 | M2   |
| `shadcn`           | 组件选择与组合、主题、表单、弹窗与无障碍             | M2   |
| `debug-and-verify` | 错误诊断、修复顺序与检查证据解释；不自行授予通过状态 | M2   |
| `skill-creator`    | 帮用户制作描述、正文、references 与脚本规范          | M4   |

生成项目先确定视觉方向并落为项目级 tokens，后续修改延续已有主题与组件，而不是每轮重新生成。Template 提供可运行基础，不决定所有项目的外观；设计 Skill 不把每个产品套成同一种页面。

`browser-validation` 仅在真实浏览器范围获确认后纳入；目前不承诺该 Skill 或 `browser_open`、`browser_inspect`、`browser_screenshot`、`browser_action` 工具。HTTP 抓取不能冒充页面操作或截图验证。

### 7.2 MVP 后的 AI 与 Agent Skill

明确安排后续交付 `ai-sdk`、`ai-sdk-4/5/6`、`eve`、`workflow`、`chat-sdk`，具体批次与兼容范围见 MVP 路线。这些是服务于用户生成项目的领域知识，仍走同一套按需加载，不是新增主 Agent，也不改变 Paimeng 自身不做 durable execution 的决定。涉及外部服务的授权、凭据与依赖在对应迭代明确，加载 Skill 不代表集成已经可用。

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
- 维持 ADR 0006，不以 Git commit 承载 Version，也不新增「仅有代码变更才记录」的触发条件；Todo、Plan 与纯文字助手消息不另设例外。
- MVP 不接入 GitHub 工作分支、自动推送与 PR 流程。对齐 v0 的版本行为、API 模型或远端同步留待后续评估，不是已承诺的后续交付。

## 11. 交付顺序

垂直切片，每一步都先能演示再往下走。

1. 骨架：根目录 Next.js、Drizzle、健康检查、CI。
2. 沙箱：Docker `SandboxSession`、预览代理、模板项目能跑起来。
3. 生成闭环：单主 `ToolLoopAgent`、八项基础工具、Todo／Plan、验证与完成判定、流式与消息持久化；同时交付最小 Skill 加载与首批四个 Skill（验收 1、2、3、5、6，附加路径见 MVP 2.1）。
4. 代码面板与版本（验收 4、7），沿用源码树 Snapshot。
5. 完整技能管理、导入与信任、`skill-creator`；不把 M2 的最低生成质量推迟到本阶段。
6. 发布（验收 8）。
7. Design mode 与截图导入（验收 9、10）。
8. 搜索、模板、环境变量面板（验收 11、12、13）。

每个 PR 附浏览器录屏（GIF）、数据库行与沙箱真实输出，证据放 `runtime/evidence/`。

## 12. 未决与风险

- AI SDK 7 的 `experimental_sandbox` 接入点需要在第二个切片里实测确认：挂在 agent 设置上，还是挂在工具执行上下文里。
- `next dev` 反向代理要处理绝对路径、HMR WebSocket 与子路径 basePath，先做 spike。
- 预览与发布共用镜像，需要确认 standalone 产物在 runner 里对静态资源与 API route 都成立。
- 快照体积随项目增长，需要保留策略（例如只保留最近 N 个版本）。
- 真实浏览器自动验证尚未确认；当前验收 12 维持 HTTP 抓取与搜索。UI 交互与响应式需通过用户验收和 PR 浏览器证据核实，不能声称 Agent 已自动验证。
- 取消、异常与预算耗尽时，未完成改动如何形成可恢复状态需明确；不得改变每条助手消息记录版本的既定规则来掩盖失败。
- 用户技能脚本与生成项目共享 Sandbox。受控入口校验 Trust 不等于代码来源隔离；通用 Bash 仍有广泛能力，隔离必须靠 Sandbox 与工具权限，不能只靠提示词。
- Skill 描述不设数量上限，需观察注意力稀释与上下文增长，不提前增设分类器或 ToolSearch。

## 13. 规划依据与范围边界

2026-11-07 同步 [Agent Loop](planning/agent-loop.html) 与 [工具和 Skill 规划](planning/agent-tools-and-skills.html) 的已定内容；保留的 HTML 是讨论记录，当前架构以本文件为准。规划图表达 Paimeng 的设计，不构成对 v0 内部拓扑、工具 schema 或存储实现的证明。

当前不做动态 ToolSearch、独立任务管理平台或通用制品平台；成果通过 Preview、代码面板与截图展示。设计灵感由 `frontend-design` 提供，图片生成服务延后。GitHub 与 v0 版本对齐仅保留评估，真实浏览器仍待确认，不因工具清单而自动扩展 MVP。
