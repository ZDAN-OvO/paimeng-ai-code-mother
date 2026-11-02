# 应用运行时与开放依赖

> 已发布：https://github.com/ZDAN-OvO/paimeng-ai-code-mother/issues/136

> 状态：待评审。评审通过后发布到 issue tracker，并补 `ready-for-agent` 标签。

## 问题陈述

Owner 现在只能从四个技术栈骨架里选一个起点，骨架内容是一个任务清单示例，不是可用的页面结构。默认生成出来的东西离「能直接用」还有距离，Owner 需要反复描述布局和风格。

生成过程中模型不能安装依赖：`package.json` 的依赖集合被模板版本锁死，任何新包都会被构建拒绝，平台只能用一句错误信息让模型「恢复模板版本」。模型遇到图表、动画、Markdown、日期处理这类常规需求时，只能手写或绕开，产物质量因此下降。

模型也没有 shell：读文件、写文件、构建是三个割裂的动作，安装依赖只能靠改 `package.json` 再触发构建，失败后再改。构建一次约 4 秒，一次依赖写错就要等一整轮。

Preview 只在构建成功后出现，构建前 Owner 看不到任何东西；构建失败时，这一轮的文件改动不会成为 Version，Owner 的中间成果直接丢失。

## 解决方案

每个 App 拥有一个常驻的隔离 **App runtime**：一台按 App 分配、可被平台启动和回收的容器，里面有 Workspace 的挂载、依赖、dev server 和 shell。Preview 在运行时存活时由 dev server 直接提供，实时反映模型的每一次写入；运行时空闲回收后，Preview 回落到最近一次 self-check build 的 Delivery。

新建 App 默认使用 React 厚架子：布局骨架、设计令牌、shadcn 组件源码、路由和一个带数据的示例页面。Owner 仍可显式选择「轻量静态页」，用于不需要构建的单页站点。

依赖不再逐字节锁定：模型用 shell 自己执行安装，平台在轮末对齐锁文件并校验来源，只允许 npm registry 上的包。磁盘和安装时间由 pnpm 的共享依赖存储承担。

Version 的语义不变，仍然是 commit SHA；变化在于：构建失败的 Generation 也提交 Version 并标记构建状态；恢复一个旧 Version 会产生一个新提交，历史保持线性。Publish 仍然从 Version 的 commit 在一次性容器里重建不可变 Delivery。

## 用户故事

1. 作为 Owner，我希望新建的 App 从一个完整的 React 页面结构起步，这样第一次 Preview 就像一个真实网站，而不是任务清单示例。
2. 作为 Owner，我希望默认 Template 定义好颜色、间距、字体和布局，这样我只需要描述内容，不用描述视觉基座。
3. 作为 Owner，我希望在不需要构建的简单站点上选择轻量静态页，这样我能得到更快、更省的结果。
4. 作为 Owner，我希望平台只在需求确实简单时才选轻量路径，这样我不会拿到一个无法扩展的起点。
5. 作为 Owner，我希望模型还在写文件时 Preview 就持续更新，这样我看到的是进展，而不是一个转圈。
6. 作为 Owner，我希望半成品页面明确显示「正在生成」，这样布局残缺不会被误读为失败。
7. 作为 Owner，我希望 runtime 被回收之后 Preview 仍然能打开，这样我查看旧 App 时不会触发一次 Generation。
8. 作为 Owner，我希望模型自己安装图表库、动画库或图标库，这样我不需要知道该点名哪个包。
9. 作为 Owner，我希望安装失败时给出可读的原因，这样我能判断换个方式重试是否有意义。
10. 作为 Owner，我希望依赖只能来自 npm registry，这样一条依赖声明不能从任意主机拉取代码。
11. 作为 Owner，我希望依赖占用的磁盘在 App 之间共享，这样一台机器能放下很多 App，而不是每份依赖树都重复一遍。
12. 作为 Owner，我希望以构建错误结束的 Generation 仍然保留 Version，这样我不会因为一个类型错误丢掉整轮工作。
13. 作为 Owner，我希望每个 Version 显示构建是否通过，这样我一眼能分清可用版本和坏版本。
14. 作为 Owner，我希望恢复旧 Version 时历史里出现一条新记录，这样版本列表始终等于 App 的当前状态。
15. 作为 Owner，我希望恢复的 Version 带回它当时的依赖，这样 App 的行为和当时一致。
16. 作为 Owner，我希望 Publish 从 Version 的 commit 构建，这样即使 runtime 已经不存在，发布出来的站点仍然对应该版本。
17. 作为 Owner，我希望 runtime 睡眠时也能 Publish，这样运行时是否存活不会阻塞部署。
18. 作为 Owner，我希望发布构建失败时保留上一个 Deployment，这样一次坏构建不会打挂线上站点。
19. 作为 Owner，我希望模型在隔离环境里执行命令，这样我的其他 App 和平台本身不受影响。
20. 作为 Owner，我希望模型无法改写版本历史，这样恢复旧版本这件事是可信的。
21. 作为 Owner，我希望 App 的文件以普通文件形式留在宿主上，这样容器重启不会丢源码。
22. 作为 Owner，我希望平台升级运行时镜像后 App 仍然可用，这样升级不会悄悄弄坏我的依赖。
23. 作为 Owner，我希望命令和安装有时间与次数上限，这样一条失控命令不会吃掉整轮生成预算。
24. 作为 Owner，我希望排队中的 Generation 明确显示为排队，这样我知道为什么还没有动静。
25. 作为 Owner，我希望排队不消耗 Credit，这样等待不花我的钱。
26. 作为 Owner，我希望一个 App 在生成时另一个 App 还能用，这样槽位限制不会无谓地串行化我自己的工作。
27. 作为 Owner，我希望一段时间没碰过的 App 的 runtime 被回收，这样平台能把资源留给别的 App。
28. 作为 Owner，我希望被回收的 runtime 在下一条消息时自动唤醒，这样我不需要自己管理运行时。
29. 作为 Owner，我希望删除 App 时一并删掉它的文件、Version 和部署，这样不会留下孤儿数据。
30. 作为 Owner，我希望删除 App 时平台能删掉容器写下的文件，这样删除不会因为文件属主而失败。
31. 作为 Owner，我希望失败原因能区分模型、安装和构建，这样我知道该改什么。
32. 作为 Agent，我希望在 App runtime 里有一个 shell，这样我能查看工程、安装依赖并运行工程自己的检查。
33. 作为 Agent，我希望 shell 的环境里没有任何平台密钥，这样一条命令无法泄漏凭证。
34. 作为 Agent，我希望安装好的骨架里带有组件和令牌，这样我复用它们，而不是从头写一套设计系统。
35. 作为 Agent，我希望 runtime 在轮次之间保留，这样我上一轮装的依赖下一轮还在。
36. 作为 Agent，我希望通过只读接口读取版本历史，这样我能理解以前的决定，但改不了历史。
37. 作为 Admin，我希望看到哪些 App 占着 runtime、槽位用了多少，这样我能定位容量问题。
38. 作为 Admin，我希望手动回收一个 runtime，这样卡住的 App 不会一直占着机器。
39. 作为 Admin，我希望 runtime 崩溃时记录容器标识和最后一条命令，这样我能区分崩溃和慢安装。
40. 作为平台，我希望在提交时执行每 App 的磁盘配额，这样一条 shell 命令不能把任意数据塞进版本历史。
41. 作为平台，我希望版本仓库位于挂载的 Workspace 之外，这样容器进程改不了历史。
42. 作为平台，我希望所有 App 只有一条构建路径，这样不存在第二条遗留构建链要维护。

## 实现决策

### App runtime

- 新模块：**runtime supervisor**。它负责容器创建、健康检查、端口、空闲回收、LRU 驱逐、生成排队和崩溃对账。它是唯一允许启动或停止 runtime 容器的组件。
- 一个 App 一个 runtime。全机最多 3 个并存；连续 15 分钟没有 Generation 活动则回收；驱逐优先选空闲的，绝不驱逐持有 Write authority 的；没有槽位时 Generation 进入 `queued`，队列有上限和等待截止时间。
- runtime 以拥有 Workspace 的宿主 uid 运行，不是 root。挂载只有 App Workspace（读写）和 pnpm store；不挂 Docker socket、平台环境变量、`.env` 或任何其他 App 的目录。
- 网络完全放开。理由：很多包在安装期要拉取自己的二进制；更窄的出网点会产生难以诊断的失败。
- runtime 状态持久化（App、容器标识、端口、最后活动时间、镜像身份），平台重启后能按标签找到孤儿容器并对账。
- 唤醒是惰性的：App 的下一次 Generation 才创建 runtime；排队和唤醒的等待时间计入 Generation Deadline，但不计入 Credit。

### Workspace 与依赖

- Workspace 仍是 App 的持久源码目录，bind mount 进 runtime。`node_modules` 也放在这里；它继续被排除在 Version 提交和文件工具之外。
- 包管理器换成 pnpm。每个 App 保留自己的 `node_modules`，通过硬链接指向宿主的共享内容寻址存储。模板锁文件变成 `pnpm-lock.yaml`。
- 依赖来源只允许 registry 包名和版本范围；`git:`、`file:`、`link:`、`http(s):`、`workspace:` 仍然拒绝；`overrides` 允许。
- Agent 通过 shell 安装包。Generation 结束时平台在 runtime 内执行一次锁文件归一化，无法与 `package.json` 对齐就判这一轮失败。
- 重装规则：镜像身份或锁文件哈希与记录的配对不一致时，runtime 在提供 Preview 之前重新安装依赖。
- 依赖白名单、两阶段安装/构建容器、模板锁逐字节校验全部删除，只剩一条构建路径。

### Version 与历史

- Version 身份仍是 commit SHA。版本台账保持现有职责：决定有哪些 Version、顺序如何；文件事实仍由 Git 提供。
- 版本仓库从 Workspace 移到平台的版本存储，成为裸库；Workspace 是它的 worktree。容器进程因此看不到 `.git`。
- 平台用临时索引从 Workspace 提交；容器永远不提交。
- 恢复产生一个新提交：树是目标 Version 的树，父提交是当前 head。恢复是幂等的：恢复到当前 head 不产生提交。
- Version 记录增加构建状态（pending、passed、failed）和一句诊断。以构建失败结束的 Generation 仍然提交并记录失败。
- 提交上限作用于整个 worktree 的差异，而不只是文件工具的写入：最多 1,000 个文件、总计 50 MiB、单文件 10 MiB。超限时提交失败并给出可读原因，Workspace 保持原样。

### 构建与 Delivery

- **Self-check build**：模型主动请求，在 App runtime 内执行，产出用于 Preview 回落和模型诊断的 `dist`。
- **Platform build**：Publish 时在一次性容器里、从 Version 的 commit 构建，而不是从活的 Workspace 构建。它按锁文件安装，执行模板的类型检查和构建命令，产物就是不可变 Delivery。
- Publish 成功后，platform build 的产物替换该 Version 的 Preview 回落 `dist`。
- Delivery 的不可变语义和部署语义不变；每次发布继续复用 App 的 deploy key。

### Preview

- Preview 服务改成按 App 反向代理：runtime 存活时代理到该 App 的 dev server，包括 HMR websocket；runtime 睡眠时提供该 App 当前 Version 的最后一份 `dist`。
- Preview 继续使用独立来源、Cookie 隔离和 CSP。可视化编辑桥接由代理注入到被代理的 HTML，且在 Generation 持有 Write authority 期间禁用。
- 生成期间 Preview 只读；元素选中和编辑只在 Generation 收束后接受。

### Agent 工具

- 新增 `shell` 工具，在 App runtime 内执行命令。限制：单条命令 120 秒、每轮 40 条、返回 8 KiB 输出（完整输出留在运行时日志里）。
- 文件工具继续在宿主上对 Workspace 执行。它们仍是修改文件的首选路径，但不再是安全边界；边界变成挂载范围和提交上限。
- 只读 Git 工具继续在宿主仓库上工作。提示词明确告诉 agent：容器里没有 `.git`。
- 提示词改动：模板说明取代四套 Generation type 规则；依赖限制那句话换成 registry-only 规则；要求 agent 优先复用已装组件和令牌。

### Template 与路由

- 新增 Template `react-ts@2.0.0`（React、Vite、TypeScript、Tailwind v4、shadcn 组件源码、lucide、react-router，一个带数据的示例页面）。它成为构建类 App 的默认 Template。`react-ts@1.0.0` 留在代码里，但不再提供选择。
- `vue-ts` 和 `multi-file` 保留代码路径，但从创建界面移除；界面只提供轻量静态 Template 和 React 厚架子。
- 路由变成二分类：轻量静态，或构建类 App。四分类 Generation type 从产品面退役；存储暂时保留现有列。
- 存量 App 及其数据直接删除，不做迁移。删除脚本先 dry-run，待新路径验证通过后执行，清掉 App 行、Workspace、版本仓库、Delivery、Deployment、Cover 和上传文件，保留用户、Credit 和账本。

### 计费与容量

- Credit 只按 Generation 窗口计费：唤醒、安装、命令、构建和结算。排队时间和 runtime 空闲时间不计费。
- `queued` 加入 Generation 状态词汇和 SSE 事件流。
- runtime 崩溃在平台启动时和 supervisor 每个 tick 对账；崩溃的 runtime 在接收新 Generation 前从 Workspace 和锁文件重建。

### 配置

- 运行时镜像固定 `node:24-alpine`，带 pnpm 和 git。
- 可配置项：槽位上限、空闲超时、队列上限、排队等待截止、命令超时、命令条数、输出截断、提交上限、store 路径、镜像身份。
- 超时做成配置项，让 system 测试能在秒级验证回收和排队，而不必等 15 分钟。

## 测试决策

好的测试断言外部可观察的结果：Generation 到达某个状态、某个 Version 存在并带构建状态、Preview 提供当前源码、发布构建失败后 Deployment 仍提供旧内容。测试不能断言内部调用顺序、容器名或日志文本。

测试缝按高低排列，全部复用现有四层，不新增：

1. **E2E 隔离启动器**——主验收缝。驱动真实平台、harness、runtime 和预览服务：创建 App、看到实时 Preview、安装一个包、触发构建失败、看到带失败状态的 Version、发布、恢复，确认 Preview 和 Deployment。先例：生成验证 spec。
2. **system 套件**——真 Docker、Chromium 和真实预览服务。覆盖 runtime 生命周期：冷启动、空闲回收、LRU 驱逐、排队、崩溃对账、文件属主、提交配额。超时通过配置压到秒级。先例：模板构建 system 测试。
3. **integration 套件**——真 Postgres 和 Redis，不起 Docker。覆盖版本台账的构建状态、恢复即提交的幂等、提交上限、依赖来源校验、队列状态迁移。先例：版本存储与模板生成测试。
4. **unit 套件**——纯策略：轻量静态路由、manifest 来源校验、提交上限计算、模板解析。先例：模板与生成指令测试。

需要联网的装包 E2E 步骤单独标记，可在没有出网的机器上跳过；流程其余部分使用已安装的依赖，保持离线可跑。验收证据沿用仓库的证据包约定：结论、断言所在测试行、产物。

## 范围外

- 多套视觉风格的 Template 库和用户发布 Template。
- Vue 厚架子。
- 服务端渲染、生成 App 内的 API 路由，以及任何超出静态产物的运行时。
- 共享 pnpm store 的多租户隔离；出现第二个用户时需要按用户分 store 或退回只读依赖层。
- Deployment 模型、自定义域名或公网 HTTPS 的改动。
- 存量 App 迁移；它们的数据被删除。
- Design system skills、registry 导入以及其他 Template 相邻机制。

## 补充说明

- 本 spec 取代在途容量计划里的构建队列部分：单全局构建槽和一次性构建任务被「每 App runtime + 调度队列」替换。那份计划里的沙箱章节需要在本轮落地时重写或归档。
- 本机原型实测：空容器 21.7 MiB；一个 Vite dev server 的 cgroup 占用 80.7 MiB；同容器两个 dev server 156.1 MiB，两个容器 158.4 MiB；硬链接的第二个 `node_modules` 只多占 5.3 MiB 而不是 200 MiB。容器合租只省约 2.3 MiB，所以密度来自空闲回收，不是靠合租。
- 实测中发现：root 容器写 bind mount 会留下宿主用户删不掉的文件。runtime 必须以宿主 uid 运行，否则删除 App 会失败。
- `memory.current` 包含可回收的 page cache；配额和监控必须用匿名内存，否则会杀掉健康的 runtime。
- 实现阶段要验证的风险：HMR websocket 经过代理；dev server 崩溃检测；3 个槽位的端口分配；pnpm store 的并发与共享写入面；镜像或锁文件变化后的冷启动延迟；提交上限与合法大素材的冲突。
- 候选 ADR：runtime 的归属与隔离边界；版本仓库移出 Workspace；恢复即新 Version；发布只从 commit 构建。
- GLOSSARY 需要补充：App runtime、dev server、shell、dependency store、Version 构建状态、`queued` Generation 状态。现有「Workspace 避免使用 sandbox 一词」的约定继续有效。
