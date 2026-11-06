# App runtime 分阶段计划

让 Owner 在生成途中看到页面进展，让 Agent 能在 App 自己的容器里安装依赖，并保留构建失败的源码版本。
范围覆盖外置版本库、常驻 runtime、Generation 排队与 shell、实时 Preview、React 厚模板、从 commit 部署和资源回收。
不加入 SSR、生成应用后端、多机调度、Vue 厚模板、模板市场或存量迁移。
整体通过条件：真实浏览器完成创建→实时修改→安装包→失败 Version→修复→部署→睡眠→恢复→再次部署；旧 Deployment 在坏构建后仍可访问。
2026-11-03 的 S1/S2/S3 spike 原件已按附录 D 路径还原并逐项核对，附录 A 的数值可从原始 JSON 复现（B1）。两套验证工具已固定版本并分发到本工作树（B2）。产品口径 D1/D2 保留已确认状态。实施按本文顺序逐个 PR 进行。

## How to read this

Status. Ready.

Blockers. None.

Resolved. B1 于 2026-11-04 关闭：spike 原件已还原到附录 D 路径，附录 A 的每个数值都由原始 JSON 复现，文件 hash、环境与适用边界记录在 `runtime/evidence/app-runtime/preflight/spikes.md`。B2 于同日关闭：两套验证工具的逐文件 SHA-256、分发步骤与证据包检查规则记录在 `runtime/evidence/app-runtime/preflight/verifier-source.md`。S1/S2/S3 的结论只对 2026-11-03 那次运行和本机镜像成立。

Execution. 前置项核对完成后，按本文顺序逐个 PR 实施并记录证据。每个 PR 只交付到 merge-ready；推送、创建 PR、真实存量删除和合并分别另获授权。前序 PR 完成独立核验并合入后，下个 PR 才开工。

Roles. 实施者负责产品代码、检查代码与原始证据；每个 Behavior PR 由未参与该 PR 产品或检查修改的一名核验者使用 `/verify-pr` 独立运行用户路径、核对原始产物。可由 operator 担任，使用 Agent 则须另有委派授权；作者自验仅为准备，缺独立核验时保持 pending。operator 审交互和产品决定，并决定是否合并。

Permissions. 本轮授权编辑本计划、实施各 PR 的产品代码与检查、运行隔离测试并记录证据。不重跑 spike、不推送、不创建 PR、不合并、不发 tracker 消息、不执行真实存量删除或数据清理。附录 A 仅保存实验结论，不能补足缺失的原始证据。计划认可不代表发布、合并或删除存量数据授权。

未来任务全部保持未勾选。勾选前必须有对应版本的实际证据，不能用本文列出的验收目标代替结果。
所有 `runtime/evidence/app-runtime/PR-XX/` 均相对产品目录，是实施期间的证据索引目录，不代表本轮已有产物。

## Program checklist

### Start and sequence

实施前先完成以下前置项。四项已于 2026-11-04 完成，记录在 `runtime/evidence/app-runtime/preflight/`。

- [x] 关闭 B1。恢复 S1/S2/S3 的报告、复现脚本和原始产物，核对源 SHA、环境、脚本 hash、观察结果与适用边界。将它们放回附录 D 列出的原路径，或改为核验者可访问的固定版本证据地址。只恢复摘要不能关闭阻塞。原件无法取得时，先申请最小重跑范围，再补真实证据。记录到 `runtime/evidence/app-runtime/preflight/spikes.md`。
- [x] 关闭 B2。取得根 `.pi/skills/verify-paimeng-agent/` 和产品 `.claude/skills/verify-paimeng/` 两套验证工具的权威来源、固定版本或 commit、逐文件 SHA-256 清单及依赖安装命令，记录到 `runtime/evidence/app-runtime/preflight/verifier-source.md`。外部 `.pi/` 工具包当前来源未知；产品 `.claude/` 技能当前可读但未随基线提交分发。分别交付可复核的固定版本文件包或提交引用，不编造下载或安装命令。任一来源或分发步骤未交付时保持阻塞。
- [x] 验证工具可分发。按已核验的安装命令，在每个独立工作树显式安装同一工具包到仓库根 `.pi/skills/verify-paimeng-agent/`。安装前检查目标目录，不覆盖已有不同版本。核对 `SKILL.md`、`doctor.sh`、`run-proof.sh`、`lib/bundle.mjs` 的存在性、依赖和 hash，归档工具原文及证据包检查规则。命令执行前先审查副作用；实际 doctor 和证据包自检在获准的验收环境进行。新 worktree 不会自动继承未入库工具，缺包或版本漂移即停止。
- [x] 关闭以上前置项后，更新 Blockers 和原始证据索引，再运行 readiness checker。只有无阻塞且检查通过，才将状态改为 Ready。Ready 不等于实施授权。

依赖为 `PR-01 → PR-02 → PR-03 → PR-04 → PR-05 → PR-06 → PR-07 → PR-08`；全部顺序交付，不声明可并行。每条分支命名 `agent/app-runtime-p01` 至 `agent/app-runtime-p08`，基于前一 PR 合并后的最新目标分支；首条基于最新 `origin/main`。开工先比较调查 SHA 与新基线，重新确认调用者和迁移序号。

PR-01/02 是可被旧流程调用的基础；PR-03 原子切换稳定 Workspace 与生成构建；PR-04 开 shell 并补失败 Version；PR-05 再开启实时 Preview；PR-06 提供新模板；PR-07 切换部署构建；PR-08 收尾运维、删除和文档。中间态允许旧的静态 Preview/部署行为持续存在，直到各自替换 PR 合入，不能提前声称整体规格已满足。

`business.ts`、`infra/schema.ts`、`package.json` 和 harness 入口由当期 PR 单独改；下个 PR 在合并后接续。新必填参数、工具名、状态和协议版本必须在同一 PR 迁移所有调用者，不允许留到下一 PR。每个 PR 的 Files 包含现有入口、夹具和探针；实施前再用 `rg` 核对新增调用者。

公共文件范围同时适用于所有有 Web 验收的 PR。每个 PR 单独拥有产品目录下 `.claude/skills/verify-paimeng/journeys/` 中本 PR 对应的旅程，以及 `features/` 中受影响的功能地图；配置或 helper 确需调整时也归当期 PR。外部 `.pi/` 工具包保持 B2 固定版本，功能地图更新记录实际 diff 和 hash，不能静默改变 runner 或证据包检查规则。两套驱动须证明相同用户结果，不能只更新隔离 spec 就宣称开发实例 live 已覆盖。

Parallel. None. 八个 PR 共用 Workspace/Generation/Delivery 契约、迁移序号和隔离测试库，按单一依赖链串行交付；不允许跨 PR 并发写同一文件或外部状态。

Feasibility. 附录 A 的 S1（跨挂载硬链接及 virtual store）、S2（Vite 子路径 HTTP/HMR）和 S3（Docker 后台写者停止屏障）目前只有历史摘要，须先通过 B1 核验原始产物，才可据其确定实施方案。D1/D2 是已确认产品决定。真实模板、产品代理和数据库调度仍须按各 PR 验收。若实施版本或条件不匹配，或出现新的承重假设，保持相关部分为 Draft，准备获授权的最小 spike，不沿用不适用证据。

Acceptance. 以下为整体验收的权威映射，故事编号对应规格；每行给出负责交付的 PR、观察面、失败条件和证据目的地。PR-08 的最终覆盖表逐项补入 42 个故事的断言源码行及实际产物链接，引用本表，不另立较弱标准。

| 故事 | 整体条件与负责 PR | 观察面 | 失败条件 | 证据目的地 |
| --- | --- | --- | --- | --- |
| 1–4、34 | PR-06：React 厚模板、令牌/组件复用、轻量入口和保守二分类 | Web、API、真实模板构建 | 默认/显式模板与文件不一致、仍向新建暴露四分类、组件/路由/资源不可用 | `runtime/evidence/app-runtime/PR-06/template-journey/`、`template-facts.json` |
| 5–6 | PR-05：首轮未 build 即可见、多次写入 HMR、生成标识与只读编辑限制 | Web、Preview | 等到轮末才可见、HMR 整页刷新/串 App、持写权限时仍可编辑 | `runtime/evidence/app-runtime/PR-05/preview-journey/`、`preview/` |
| 7 | PR-05：正常空闲、暂停、睡眠和坏版本按状态契约回落最近成功 Delivery 并标真实版本，无成功版本为空态 | Web、Preview | 查看触发唤醒或扣费、正常停止误报崩溃、把旧产物标为失败版、无产物时伪装成功 | `runtime/evidence/app-runtime/PR-05/fallback-facts.json`、`web/` |
| 8–10 | PR-02 提供依赖核心，PR-04 接 shell 安装和可读失败；声明来源仅 registry | API、真实 pnpm、Web | 新包不能真实安装使用、来源校验放行非 registry、安装失败不可辨认 | `runtime/evidence/app-runtime/PR-02/checks.log`、`runtime/evidence/app-runtime/PR-04/shell-journey/` |
| 11 | PR-02：两个挂载下包文件共享，第二 App 增量满足既定 20% 上限 | System、宿主 inode/blocks | 包文件不同 inode 或重复安装磁盘超限，不能用符号链接数代替证明 | `runtime/evidence/app-runtime/PR-02/lifecycle.json`、`perf.json` |
| 12–13、31 | PR-04：合法失败源码仍有 Version、构建状态/诊断持久，区分模型/安装/构建 | Web、API、Git | 构建失败丢源码、刷新丢状态、旧成功掩盖较新失败 | `runtime/evidence/app-runtime/PR-04/version-facts.json`、`web/` |
| 14–15 | PR-01：恢复追加父为当前 head 的新 Version，当前恢复幂等；PR-03/04：恢复依赖按该版锁重建 | Web、API、Git、真实安装 | HEAD 被回退、重复当前恢复多一版、恢复源码与锁/安装不一致 | `runtime/evidence/app-runtime/PR-01/restore-journey/`、`runtime/evidence/app-runtime/PR-03/build-callers.json`、`runtime/evidence/app-runtime/PR-04/version-facts.json` |
| 16–18 | PR-07：睡眠时从选定 commit 构建，不唤醒 runtime，坏构建保留旧 Deployment | Web、API、Deployment | 活 Workspace 混入、SHA/锁/内容不一致、旧 URL 中断或混合产物 | `runtime/evidence/app-runtime/PR-07/deploy-journey/`、`deployment/` |
| 19–20、33、36、41 | PR-01 外置只读历史；PR-02 挂载/环境；PR-04 shell 绑定与停止屏障 | API、System、Git | 容器能改历史、暴露平台密钥/其他 App Workspace、停止后仍写入 | `runtime/evidence/app-runtime/PR-01/git-layout.json`、`runtime/evidence/app-runtime/PR-02/container-facts.json`、`runtime/evidence/app-runtime/PR-04/api/` |
| 21–22、35 | PR-02 镜像/锁变化重装；PR-03 持久 Workspace/跨轮依赖；PR-04 真实命令链 | System、Web、API | 重启丢源码、跨轮依赖消失、镜像/锁变更仍复用失效安装 | `runtime/evidence/app-runtime/PR-02/lifecycle.json`、`runtime/evidence/app-runtime/PR-03/workspace-facts.json`、`runtime/evidence/app-runtime/PR-04/shell-facts.json` |
| 23、32 | PR-04：真实 shell、超时/次数/返回体限额，正常/异常收束都停止后台写者 | API、System、Web | 41 次仍执行、超时后仍写入、输出超 8192 bytes、停止屏障超 5000 ms | `runtime/evidence/app-runtime/PR-04/shell-facts.json`、`checks.log`、`perf.json` |
| 24–26 | PR-03：持久排队、取消/刷新/重启、跨 App 并发和 D1 token 计费 | Web、API、SQL | queued 启模型/扣额外费用、重复任务、失队列、超容量或无谓串行化 | `runtime/evidence/app-runtime/PR-03/queue-journey/`、`api/` |
| 27–28 | PR-02 回收/LRU/崩溃对账，PR-03 下条消息惰性唤醒，PR-05 睡眠访问不唤醒 | System、Web、Preview | 驱逐活动写者、孤儿/重复槽位、空闲不回收、下一轮不能恢复 | `runtime/evidence/app-runtime/PR-02/system/`、`runtime/evidence/app-runtime/PR-03/web/`、`runtime/evidence/app-runtime/PR-05/web/` |
| 29–30 | PR-08：完整删除及失败可重试；PR-02：宿主 uid 可删性 | Web、API、CLI、文件/SQL | App 私有资源残留、失败伪报成功、删目标外资源或改变用户/余额/账本 | `runtime/evidence/app-runtime/PR-08/admin-delete.json`、`reset-rehearsal/`、`api.json` |
| 37–39 | PR-08：管理员状态/回收/诊断；普通用户拒绝、活动写者保护 | Web、API | 无诊断、越权、强制回收活动写者、回收后下一轮不能唤醒 | `runtime/evidence/app-runtime/PR-08/admin-journey/`、`api.json` |
| 40 | PR-04：整个差异按 1000 文件/50 MiB/单文件 10 MiB 预检；下游预算兼容 | API、Git、Web | 越限推进 head、合法预算被旧限制拒绝、拒绝后 Workspace 丢失 | `runtime/evidence/app-runtime/PR-04/quota-facts.json`、`checks.log` |
| 42 | PR-02 定义唯一构建核心，PR-03 迁移全部入口，PR-07 接 commit 构建，PR-08 删除旧链并完成全旅程 | System、API、Web、Deployment | 任一入口仍走旧双阶段/白名单链，或完整用户旅程失败 | `runtime/evidence/app-runtime/PR-03/build-callers.json`、`runtime/evidence/app-runtime/PR-07/source-facts.json`、`runtime/evidence/app-runtime/PR-08/acceptance-map.md` |
| 全部 | 各 PR 负责自己的性能、回归、独立核验和适用交互评审；PR-08 汇总 | 各 PR 声明的所有面 | 任何既定预算/覆盖未满足、缺独立核验或必要 operator approval | 各 PR 的 `perf-verdict.md`、`handoff.md`，最终 `runtime/evidence/app-runtime/PR-08/acceptance-map.md` |

Changes. 调整验收条件、性能预算、覆盖范围或不适用理由前，须 operator 明确审阅；在当期 `handoff.md` 保留旧标准、变更理由和决定。失败后降阈值、删场景或把必需项改为不适用，不能据此取得通过。

每个 PR 是一个串行集成波次：以其 Files 的 Base 解析真实分支和 SHA，前序合并后再创建下条分支；不预先以未合入父分支开工。每波运行当期全部 Verify 命令、共同 generation 探针和新旧消费者/loader 检查；合入后对目标分支实际 SHA 重查集成。若 base 漂移，先重做受影响检查与独立核验。遇 stop/hold 立即停止新增写入，把分支、SHA、未完成项、占用资源和原始证据写入当期 `handoff.md`，只清理本轮拥有的资源。

### Evidence rules

Versions. 每次运行保存 base/head 完整 SHA、各自 diff、镜像 digest、pnpm/Node/Git/Chromium/Docker 版本、配置、锁文件 hash、探针 hash、测试库名和 fixture 版本到当期目录的 `versions.json`。本次调查基线为 `13ef405b092afe704776ed8a4f0dd736457800ae`，本地 `origin/main` 为 `e70de98f6e8fbbc78a336e31256835c00a9202f0`；没有联网刷新，不能当作实施时远端最新版本。
Invalidation. 改代码、基线、镜像、锁、配置、数据或探针后，重跑受影响的自动、live 和 perf 检查；旧证据保留在独立运行子目录，不能覆盖后声称仍绑定旧 SHA。
Input boundary. 用户操作走 Playwright 的登录、创建、聊天、版本、部署和管理页面；只允许 API 注册唯一测试账号。模型可用 harness fixture 驱动，但 runtime、pnpm、Git、构建、Preview 和本地 Deployment 必须真实执行。shell/装包场景不得在 build 边界打桩。故障注入位置和只读 SQL/文件诊断必须写进报告；不把 fixture 结果扩大成真实模型质量或公网部署结论。

每个 PR 的验证块都要绑定“结论→断言源码行→原始产物”。截图至少覆盖操作前、关键中间态、结果及刷新；涉及时间变化时留视频/trace。断网跳过只适用于明确标记的联网装包用例，其他必需场景缺失则不能判整个 PR 通过。

### Boot recipe

以下步骤用于各 PR 的验收。B1/B2 已于 2026-11-04 关闭，工具已按固定版本分发；未获准的路径仍不启动服务或重置测试库。

先区分两条验证路径，分别归档原始产物，不能互相替代。

- 隔离回归路径负责 unit、integration、system、隔离 E2E、性能采样及故障副本。仅使用 `paimeng_app_test`、`paimeng_agent_test` 和 Redis DB15。重置命令与 `test:e2e:isolated` 只能进入这条路径。
- 开发实例 live 路径负责各 PR 的真实浏览器用户旅程和交互评审，遵守产品 `AGENTS.md`。使用运行中的开发 app、真实开发数据库和非 DB15 的开发 Redis 配置。只操作本轮新建的测试账号与 App，不重置库，不复用隔离启动器。开发实例必须由本轮独占；不能停止他人的日常实例。
- 每个 PR 的 Resources 中，`_test`、故障注入和批量负载约定只适用于隔离路径。Web 用户旅程另用开发实例 live 路径。API、Preview、Deployment 的用户可见结果在 live 路径核对，进程故障、批量并发和 CLI 清理演练仍在隔离路径完成。两条路径的必需项都通过，才能交付该 PR。

1. 每个 PR 使用独立工作树与证据目录，base/head/故障副本串行运行，不与其它重置测试库的任务并发。先核对 B2 的工具版本和逐文件 hash，再从仓库根运行 `bash .pi/skills/verify-paimeng-agent/doctor.sh`。按所选路径核对数据库名与 Redis DB，解决 FAIL，保存 WARN；doctor 通过不替代数据库目标核对。各版本使用独立 runtime 子目录和运行标识。现有 launcher 的固定 runtime 行为由 PR-02 修正，防止互读容器和产物。
2. 先从目标分支记录 trunk 行为，再验 head。基线工作树安装它自己的 npm 依赖，并使用相同路径类别的环境配置。开发实例的两侧顺序运行，各自使用唯一测试 App，不 reset 开发库；隔离路径则串行使用 `_test` 库。不得复制 head 的新 flag 到不认识该 flag 的 trunk。
3. 隔离路径先在产品目录运行 `npm run db:test:setup`。再运行 `E2E_APP_MODE=dev E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 E2E_HARNESS_PORT=5599 npm run test:e2e:isolated -- tests/e2e/generation-verify.spec.ts`，各 PR 用下方指定的新 spec 替换。发布构建回归显式改为 `E2E_APP_MODE=production`。两种模式均强制 `_test` 并可能重置 harness；dev 只代表开发构建，不是开发库 live 证据。端口占用即失败，另选一组空闲端口并记录，不能杀其他服务。
4. 开发实例 live 路径使用产品 [验证技能](../../.claude/skills/verify-paimeng/SKILL.md)的 Launch、Doctor、Drive 和 Cleanup，按其当前入口启动 `npm run dev`，模型仅使用 fixture。现有 doctor 命令为 `npx tsx .claude/skills/verify-paimeng/doctor.ts`，驱动配置为 `.claude/skills/verify-paimeng/playwright.config.ts`。每个 PR 将所需用户旅程同步到该配置下的 journeys，再用 `npx playwright test --config .claude/skills/verify-paimeng/playwright.config.ts` 驱动。现有 `home-create` 只证明首页创建，不代替版本、排队、shell、部署和管理旅程。该技能也须按 B2 固定来源、归档文件并显式分发到每个工作树；未入库时不能假设新 worktree 自动存在。按该 checkout 的已记录方式取得开发配置，不复制或归档秘密值。禁止在这条路径运行 `db:test:setup`、集成重置器或隔离 launcher。
5. 两条路径均检查 harness `/health` 的 `ok:true`、平台 `/api/health` 的 `code:0` 和 Preview 端口。仅处于实时生成阶段时，以实际 dev-server HTTP 200 判定实时代理就绪，不只看 Docker running。正常空闲、暂停、睡眠或崩溃时，按 PR-05 的状态契约验证静态回落或空态，不要求已停止的 dev server 返回 200。trunk 没有 runtime 时记录 unsupported，不伪造 readiness。runtime 端口范围、标签和 store 隔离由 PR-02 launcher 提供，接口落地前不虚构新环境变量。
6. PR-01 新增共同探针 `scripts/verify/app-runtime-probe.mjs` 并在 `package.json` 注册 `probe:app-runtime`。比较前将其复制到独立的 `runtime/evidence/app-runtime/compare.mjs`，记录 hash。探针只在隔离路径串行启动指定 checkout 的 `test:e2e:isolated`，输入同一场景并收集外部时间，不替代开发实例 live 证据。命令形状固定为 `node /absolute/evidence/app-runtime/compare.mjs --checkout /absolute/checkout/paimeng-ai-code-agent --scenario versions --output /absolute/evidence/run`；绝对路径由本次运行真实路径填入报告，不能保留示例。PR-01 同时实现输入参数和场景集，后续 PR 扩展后将同一最新版复制到树外重测双方。探针把同一份临时 Playwright spec 放入双方 `tests/e2e/app-runtime-probe-run.spec.ts`，通过两版本共有的 launcher 参数运行。spec 只导入该 checkout 的 Playwright 与自带 helper，不导入 head 产品模块。新增能力从页面或 API 探测，trunk 缺失记 unsupported。保留临时 spec 的 hash 和 diff，结束仅删本次新建文件，不能覆盖已有文件。
7. 探针对两侧始终先跑共同 `generation` 场景（html 创建、生成、Preview、刷新）。新增能力探测不到时写 unsupported，再测 head 的绝对预算。每指标 trunk/head/trunk/head 交错，预热 1 次、采样 10 次，原始样本保留。冷安装另取 3 次隔离 store，不能删除共用缓存来制造“冷”。在线包固定包名、版本、registry 和锁 hash；网络失败单列，不与热启动比较。
8. 证据包继续使用 B2 已核验工具包的 `run-proof.sh` 与 `lib/bundle.mjs check`。按工具固定版本的实际接口打包两条路径的原始产物，不假定旧 wrapper 的 `--dev` 能运行开发库 live 验收。来源清单必须记录可执行命令、八个中文 H2 的准确要求及包检查规则；这些信息缺失时 B2 不能关闭。原始包保留在技能 `evidences/` 的实际运行目录，当期 `runtime/evidence/app-runtime/PR-XX/index.md` 分别链接隔离与 live 证据，并记录所用技能版本。新 UI 场景同步两套驱动的功能地图与旅程。
9. 隔离 launcher 通过 `finally` 和信号处理停止本轮服务；开发实例按验证技能执行 `npm run dev:stop`，仅停止本轮拥有的进程。PR-02 同时负责按运行标签停止本轮容器并确认端口释放。保留日志和证据包，只按获准的测试资源清单清理本轮临时账号、数据、容器和目录，不触碰既有 App。开发库中的删除须先取得对应测试资源的清理授权；未获准时记录残留，不擅自删除。不得执行宽泛 `pkill` 或删除共享 store。

性能规则均是本计划提出的验收上限，尚无本轮实测值。共同 generation p95 预算为不高于同机 trunk 的 120%，且不超过 180 秒；网络冷安装用独立预算。违反阈值先调查、修复，不以调整阈值取得通过。system 用可配置的短 idle/queue timeout，正常默认仍按规格 15 分钟；不靠固定 sleep 证明状态。

### Verdict and handoff

Review entity. 每个 PR 使用项目 forge 的真实 PR，正文按 `/opening-a-pr` 编写；九区块清单留在本计划，不直接充当 PR 正文。实际创建/发布须另获授权；在当期 `handoff.md` 记录 URL、目标分支、base/head、正文、原始证据、审阅与授权记录后才可交 merge-ready。若 forge 不可用，必须先由 operator 明确接受绑定同等信息和 diff/receipts/reviewer/decision 的持久审阅记录，聊天摘要不能替代。

Verdict. 每个 Behavior PR 均由未修改该 PR 产品或检查代码的核验者按 `/verify-pr` 重新运行真实用户路径，核对原始截图、trace、SQL、进程/文件事实及修改过的检查和不适用理由。只接受绑定当前 base/head 的独立 PASS 或 PASS+NOTES；任何验收失败或未证明项均不能记为 PASS+NOTES。没有获准的独立核验者时保持 pending，作者不得自行签发独立结论。

每 PR 把 `diff.patch`、检查 stdout/stderr 与退出码、live 步骤、perf 原始样本、限制和授权记录汇入 `runtime/evidence/app-runtime/PR-XX/handoff.md`。核验者打开原图、视频、trace、SQL/文件快照；不得只读实施者摘要。CI 通过仍需判断场景完整性，trunk 缺陷与 head 新回归分开登记；若旧缺陷仍违反本计划验收，同样阻止通过。

交互审阅集为 PR-01、03、04、05、06、07、08；每个都要 operator 实际审 screenshots 和 video 并记录 approval，贴媒体不等于批准。PR-02 未接产品交互，只验真实 system 行为。任何阶段只交付到 merge-ready，未获该 PR 的明确合并授权不执行 merge/auto-merge。前序 PR 未独立通过并合入时，子 PR 不可绕过；如后续改用堆叠分支，落地前先 retarget 到实际目标分支，并针对当前 base 重验集成和受影响独立结论。后续正式决定写入当期 handoff；昂贵且有替代方案的长期决定收束成最多三份 ADR，不修改既有已接受 ADR。

## PR-01 外置版本库并让恢复追加新提交

**Depends on.** None.

**Files.**

Base. Trunk.

Writes. `src/server/versioning/**`、`src/shared/versioning.ts`、`src/server/generation/tools/git-tool.ts`、`src/server/generation/durable/protocol.ts`、`src/server/generation/durable-engine.ts`、`src/server/business.ts`、`src/components/chat/version-panel.tsx`、`tests/integration/versioning/**`、`tests/integration/harness/**`、`tests/e2e/version-panel.spec.ts`、`tests/e2e/app-runtime-versions.spec.ts`、`scripts/verify/app-runtime-probe.mjs`、`package.json`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。开发实例驱动文件同时适用 Start and sequence 的公共文件范围。

Resources. PR-01 独立工作树；隔离路径串行使用 _test 库/Redis DB15、唯一账号和版本库/Workspace fixture。开发实例 live 路径另建本轮测试账号与 App，不 reset 开发库，不触碰既有 App。树外 compare 探针与临时 spec 由本 PR 单独创建并按 hash 归档。

Contract. version-store 生产外置 repo、临时索引和追加恢复结果；同 PR 迁移 business、只读 Git、generation 提交/materialize、下载/缩略图/legacy-import 与页面消费者。仓库布局改变须在本 PR 升级 Next/harness 协议，拒绝仍使用 Workspace/.git 的旧常驻进程。旧 App 临时兼容不改变已存 SHA，调用者均接新结果；探针入口由 package.json 加载，后续 PR 复用。

- [ ] 修改 `src/server/versioning/version-store.ts`、`git-guard.ts`、`version-ledger.ts`、`version-migration.ts`、`version-heal.ts`、`version-thumbnail.ts`、`src/shared/versioning.ts`、`src/server/generation/tools/git-tool.ts`、`src/server/generation/durable/protocol.ts`、`src/server/generation/durable-engine.ts`、`src/server/business.ts`、`src/components/chat/version-panel.tsx`；更新 `tests/integration/versioning/`、`tests/integration/harness/` 和 `tests/e2e/version-panel.spec.ts`；新建 `tests/e2e/app-runtime-versions.spec.ts`、`scripts/verify/app-runtime-probe.mjs`，修改 `package.json`。同步本 PR 的开发实例验证 journey。Evidence. `runtime/evidence/app-runtime/PR-01/diff.patch`.

**Build.**

- [ ] 将 Git 元数据放到 `runtime/versionstore/` 外置裸库，所有宿主 Git 操作显式绑定 repo/Workspace 和临时索引，Workspace 不留下 `.git` 文件或目录。先以临时副本演练保留 SHA 的搬移兼容，确保本 PR 单独上线不要求先删 App；这只是过渡兼容，不新增正式存量迁移能力。移除依赖 Workspace hook 的历史保护入口，宿主只读工具继续工作。Evidence. `runtime/evidence/app-runtime/PR-01/git-layout.json`.
- [ ] 同步升级 `durable/protocol.ts`，保持 `durable-engine.ts` 的拒绝门禁。新 Next 连接旧常驻 harness 时，在提交会话或调用 Git 工具前返回版本不匹配，不能让旧 `ensureVersionRepo` 重建 Workspace/.git。重启为匹配版本后，宿主只读 Git 读取外置库。PR-03 后续状态协议升级基于此版本继续递增，不能覆盖本 PR 的门禁。Evidence. `runtime/evidence/app-runtime/PR-01/protocol-facts.json`.
- [ ] 恢复用目标树与当前 HEAD 为父提交生成新 Version，当前 head 恢复幂等；业务入口必须把新 SHA 传给 Preview 指针、截图与返回值，不再拿输入的旧 SHA 冒充当前版。保留脏源码冲突保护；generation 提交、materialize、下载、封存、缩略图和 legacy-import 调用保持可用。实现 Boot recipe 共同探针。Evidence. `runtime/evidence/app-runtime/PR-01/restore-facts.json`.

**You see.**

Kind. Behavior.
Surfaces. Web, API.
Interaction. Yes.

- [ ] 版本面板恢复 A 后新增 C：C 的树等于 A、父为 B、当前为 C；刷新仍显示 C，再恢复当前 C 不多一行；旧 A/B 仍能读。Evidence. `runtime/evidence/app-runtime/PR-01/restore-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本逐项恢复旧 HEAD 移动逻辑、把 repo 放回 Workspace/.git、丢弃返回的新 SHA；运行下方同一 versioning integration 命令，分别要求“新提交父为原 head/旧历史保留”“Workspace 无 Git 元数据”“返回/指针/下载同 SHA”断言失败。dirty 冲突和并发保护各做一次绕过，要求原文件/单次提交断言拒绝；恢复 head 后重跑。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-01/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm run test:integration -- tests/integration/versioning tests/integration/harness`、`npm run type-check`、`npm run check:fast`；覆盖旧仓库兼容、临时索引、恢复树与父 SHA/重复恢复、dirty/ignored 冲突、并发恢复、只读 Git、指针、下载和新 Next 拒绝旧 harness。反例将协议号恢复为旧值，要求同一混版拒绝断言失败，再恢复 head 重跑。Pass when 所有相关用例通过，旧 harness 在工具执行前被拒绝，匹配版本重启后只读 Git 可用，Workspace 始终无 Git 元数据且已有版本不丢失。Evidence. `runtime/evidence/app-runtime/PR-01/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧通过已有版本页面执行 A→B→恢复 A→刷新→下载，记录 trunk 移动 HEAD 的实际结果。Pass when head 追加 C、内容与下载一致，旧提交可见，无未提交文件覆盖。Evidence. `runtime/evidence/app-runtime/PR-01/web/`.
- [ ] Surface. API. 经真实 `app/versions`、`app/versions/restore`、diff 与缩略图入口检查重复恢复、越权和并发写入。隔离路径另以真实旧常驻 harness 和新 Next 发起请求，记录协议响应、调用前后 Workspace/.git 存在性及外置库 refs，再重启匹配版本核对历史读取。Pass when 正确返回新 SHA，重复当前恢复不新增，忙时拒绝且历史不变；混版在会话或工具执行前明确拒绝，没有重建 .git 或改变历史，匹配版本重启后读到同一历史。Evidence. `runtime/evidence/app-runtime/PR-01/api.json`.

**Verify, perf.** Required.

- [ ] Metric. 50 条 Version 的列表、恢复请求 p95（ms），共同 generation p95（s）。Evidence. `runtime/evidence/app-runtime/PR-01/perf.json`.
- [ ] Probe. 使用 Boot recipe 的树外探针 `--scenario versions`，相同 50 版、每版一个 10 KiB 文件的 fixture；共同 generation 一并测量，两侧交错。Evidence. `runtime/evidence/app-runtime/PR-01/perf-raw/`.
- [ ] Baseline. 先实测 trunk 的列表/恢复，记录追加提交能力缺失；不把旧 restore 与新 restore 的结果语义视为相同。Evidence. `runtime/evidence/app-runtime/PR-01/baseline.json`.
- [ ] Rule. 列表 p95 不超过 trunk 120%，恢复含新增提交 p95 不超过 3000 ms；共同 generation 满足统一规则。Limit. 3000 ms. Evidence. `runtime/evidence/app-runtime/PR-01/perf-verdict.md`.

**Review gate.** Required.

- [ ] 给 operator 展示恢复、重复恢复及刷新后的 screenshots 与 video，取得 approval 后才可合并。Evidence. `runtime/evidence/app-runtime/PR-01/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。审核外置库所有路径调用者、原始证据与精确 head，保留过渡兼容验证，获得本 PR 明确合并授权。Evidence. `runtime/evidence/app-runtime/PR-01/handoff.md`.

## PR-02 建立 runtime supervisor 与统一依赖构建核心

**Depends on.** PR-01.

**Files.**

Base. PR-01.

Writes. `src/server/runtime/**`、`docker/app-runtime/Dockerfile`、`src/server/infra/config.ts`、`src/server/infra/schema.ts`、`.env.example`、`scripts/dev/durable-dev.ts`、`scripts/verify/test-e2e.ts`、`src/server/generation/durable/harness-server.ts`、`package.json`、`migrations/*_app_runtime.sql`、`tests/unit/runtime/**`、`tests/integration/runtime/**`、`tests/system/app-runtime.test.ts`、`tests/system/runtime-dependencies.test.ts`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-02 独立工作树和唯一 run-id；_test 库/DB15 与 base 串行；Workspace、store、容器标签、dev-server 端口范围按 run-id 隔离，两个 App 只在本轮 store 内共享包；镜像构建/标签由本 PR 单写，记录 digest。迁移号开工预留，若 025 被占用则追加下一空号。

Contract. runtime supervisor 是容器启停唯一生产者，harness 托管循环；提供 ensure/stop/runner 及统一 install/typecheck/build 能力，类型/配置/持久状态由本 PR 一并定义。launcher 和真实 system 驱动先消费，产品构建调用保持旧路径，PR-03 再原子切换；导入链、Dockerfile 构建入口和 readiness 同 PR 可运行。

- [ ] 新建 `src/server/runtime/` 下 supervisor、store、container、commands、dependencies 模块与 `docker/app-runtime/Dockerfile`；修改 `src/server/infra/config.ts`、`infra/schema.ts`、`.env.example`、`scripts/dev/durable-dev.ts`、`scripts/verify/test-e2e.ts`、`src/server/generation/durable/harness-server.ts`、`package.json`；追加 `migrations/025_app_runtime.sql`（若序号已占则顺延）。新建 `tests/unit/runtime/`、`tests/integration/runtime/`、`tests/system/app-runtime.test.ts`、`tests/system/runtime-dependencies.test.ts`；扩展树外探针源。Evidence. `runtime/evidence/app-runtime/PR-02/diff.patch`.

**Build.**

- [ ] 按 spike 结论实现镜像与挂载：Workspace→`/work`、共享 store→`/store` 两个 bind mount；App virtual store 固定为 `/store/apps/<key>/.paimeng-virtual`，平台安装与模型 shell 都设置 `npm_config_virtual_store_dir`；Workspace 的 `node_modules` 保留为指向 virtual store 的符号链接，不使用默认 `/work/node_modules/.pnpm`。容器以宿主 uid/gid 运行并加 `--init`；supervisor 在 harness 进程托管周期循环，通过 Postgres 互斥控制 runtime，Next 不直接 Docker create/stop。隔离镜像固定 Node 24 Alpine 基础 digest、pnpm 精确版本和镜像身份；命令环境只给显式白名单，不继承平台密钥。Evidence. `runtime/evidence/app-runtime/PR-02/container-facts.json`.
- [ ] 实现持久状态与标签对账、3 槽、15 分钟 idle、LRU、Write authority 保护、健康检测、失败清理和端口分配；Docker 启停不持有长事务，失联槽位先核对容器再释放。实现 registry-only manifest/overrides/锁文件来源校验、归一化、image+lock 配对失效重装和共同 install/typecheck/build 核心。system 驱动必须覆盖两个 App 的同包 inode/nlink 共享、第二 App 增量、`--init` 前后僵尸数、detached/setsid/忽略 TERM 的进程清理；独立驱动调用新模块，产品暂不切到新 runtime。Evidence. `runtime/evidence/app-runtime/PR-02/lifecycle.json`.
- [ ] launcher 为每轮配置隔离的 runtime/store、容器标签和端口范围，记录 readiness/清理；配置优先级与旧默认兼容。明确一次性 platform build 不是常驻 runtime 槽位，其执行上限共用现有 generation/deployment 准入约束；不得让大量 Publish 绕过机器资源上限。Evidence. `runtime/evidence/app-runtime/PR-02/launcher.json`.

**You see.**

Kind. Behavior.
Surfaces. System.
Interaction. No.

- [ ] 真实容器可启动、提供模板 dev 页面、回收、重建；重启 supervisor 能识别自己管理的容器，跨进程不能超过槽位，宿主用户可删除容器所写文件。Evidence. `runtime/evidence/app-runtime/PR-02/system/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本分别切回默认 virtual store、移除 --init、绕过槽位/Write authority 保护、禁用崩溃对账或 image+lock 失效重装、放行一个非 registry 声明、禁用停止屏障；运行下方 runtime integration/system 命令，要求 inode/增量、僵尸数、最多 3 槽/活动写者、孤儿/重装、来源拒绝和 5 秒无迟到写入断言各自失败。挂载/环境检查另以受控 fixture 增加无敏感内容的哨兵路径/变量，要求可见范围断言拒绝；不得注入真实密钥。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-02/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm test -- tests/unit/runtime`、`npm run test:integration -- tests/integration/runtime`、`npm run test:system -- tests/system/app-runtime.test.ts tests/system/runtime-dependencies.test.ts`，再跑类型与 fast 检查。Pass when 校验拒绝非 registry/lock 注入、镜像或锁变化触发重装、跨进程最多 3 槽、idle/LRU/崩溃均可观测收束；两个 App 的同包文件同 inode 且第二 App 增量 ≤20%，无 `--init` 的僵尸数明显大于有 `--init` 的对照。Evidence. `runtime/evidence/app-runtime/PR-02/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. System. 两侧运行现有真实 React/Vue 模板构建并保留旧产物保护结果；trunk 无常驻 runtime 单列。head 另外启动 4 App、杀容器/杀 supervisor、修改锁和镜像身份，并测 detached/50 写者的轮末屏障与僵尸回收。Pass when 原有构建仍通过，新 runtime 只有 3 个且活动写者不被驱逐，重启不产生孤儿/重复分配，屏障后 5 秒 Workspace hash 不变。Evidence. `runtime/evidence/app-runtime/PR-02/system/`.

**Verify, perf.** Required.

- [ ] Metric. 冷/热安装秒数、两个 App node_modules+store 实际分配磁盘 MiB、3 个空闲 dev server 匿名内存 MiB、回收秒数。Evidence. `runtime/evidence/app-runtime/PR-02/perf.json`.
- [ ] Probe. 树外探针 `--scenario lifecycle`，调用隔离 system 驱动，读取 HTTP/cgroup memory.stat anon 与宿主 inode/blocks；固定 S1 的包集；trunk 使用相同模板现有构建，runtime 指标写 unsupported。Evidence. `runtime/evidence/app-runtime/PR-02/perf-raw/`.
- [ ] Baseline. 首先测 trunk 安装构建与磁盘；再交错 head，不用不同模板算加速比。Evidence. `runtime/evidence/app-runtime/PR-02/baseline.json`.
- [ ] Rule. 固定镜像已在本机时，冷安装单次不超过 180 s，热唤醒 p95 不超过 15 s，3 runtime 空闲匿名内存总计不超过 768 MiB；重复包第二份安装新增分配磁盘不超过首份 20%，缩短 idle 后 10 s 内回收。Limit. 180 s. Evidence. `runtime/evidence/app-runtime/PR-02/perf-verdict.md`.

**Review gate.** Not applicable. 本 PR 仅新增未接入用户界面的核心与 system 驱动，没有产品交互变化；真实资源证据仍须核验。

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。核验 spike 结论已按证据落地（virtual store 路径、inode/nlink、`--init`、屏障），旧构建未被提前替换，资源上限和清理验证通过后交 merge-ready，等待明确合并授权。Evidence. `runtime/evidence/app-runtime/PR-02/handoff.md`.

## PR-03 接入稳定 Workspace 和持久 Generation 排队

**Depends on.** PR-02.

**Files.**

Base. PR-02.

Writes. `src/server/generation/generation-lifecycle.ts`、`src/server/generation/control-store.ts`、`src/server/generation/generation-store.ts`、`src/server/generation/durable-engine.ts`、`src/server/generation/agent.ts`、`src/server/generation/durable/harness-server.ts`、`src/server/generation/durable/faux-fixture.ts`、`src/server/generation/durable/fixture-content.ts`、`src/server/generation/durable/effect-gate.ts`、`src/server/generation/durable/protocol.ts`、`src/server/generation/tools/build-preview-tool.ts`、`src/server/workspace/execution-workspace.ts`、`src/server/workspace/workspace.ts`、`src/server/delivery/artifacts.ts`、`src/server/delivery/build-contract.ts`、`src/server/delivery/build-feedback.ts`、`src/server/templates/templates.ts`、`src/server/business.ts`、`src/server/billing/settlement.ts`、`src/shared/contracts.ts`、`src/shared/chat-runtime.ts`、`src/app/api/durable/[...path]/route.ts`、`src/app/app/chat/[id]/**`、`src/components/chat/generation-feedback.ts`、`src/components/chat/generation-usage.tsx`、`scripts/verify/stress-queues.mjs`、`migrations/*_generation_queue.sql`、`tests/unit/generation/**`、`tests/unit/billing/**`、`tests/integration/generation/**`、`tests/integration/harness/**`、`tests/integration/delivery/**`、`tests/integration/billing/**`、`tests/system/template-build.test.ts`、`tests/system/build.test.ts`、`tests/e2e/app-runtime-queue.spec.ts`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-03 独立工作树；两个 Next/一个 harness 的并发用例仅共享本轮 _test 库/DB15。准入、重复请求和重启用例使用 12 个唯一 App。默认满队列用例另用 36 个唯一 App，分别承担 3 个运行项、32 个等待项和 1 个溢出请求；两组串行运行，base/head 串行重置。开发实例 live 另建自己的测试 App，不运行批量重置。继承 PR-02 的 run-id 隔离与端口预留；追加队列迁移时预留下一空号，不改已应用迁移。

Contract. generation-lifecycle/control-store 生产 queued 与稳定 Workspace 交接；同 PR 迁移 API、SSE、Next/harness 协议、全部 busy/取消/恢复扫描/计费/UI/压测消费者。artifacts/buildApp 薄适配消费 PR-02 核心，所有旧构建调用者同时迁移；PR-04 shell 尚未暴露时不得依赖未来工具维持当前交接正确性。

- [ ] 修改 `src/server/generation/generation-lifecycle.ts`、`control-store.ts`、`generation-store.ts`、`durable-engine.ts`、`agent.ts`、`durable/harness-server.ts`、`durable/faux-fixture.ts`、`durable/fixture-content.ts`、`durable/effect-gate.ts`、`durable/protocol.ts`、`tools/build-preview-tool.ts`、`src/server/workspace/execution-workspace.ts`、`workspace.ts`、`src/server/delivery/artifacts.ts`、`build-contract.ts`、`build-feedback.ts`、`src/server/templates/templates.ts`、`src/server/business.ts`、`src/server/billing/settlement.ts`、`src/shared/contracts.ts`、`chat-runtime.ts`、`src/app/api/durable/[...path]/route.ts`；追加队列表/索引迁移。更新 `src/app/app/chat/[id]/page.tsx`、`use-generation-sync.ts`、`src/components/chat/generation-feedback.ts`、`generation-usage.tsx`、`scripts/verify/stress-queues.mjs` 与相关 unit/integration/system 测试；新增 `tests/e2e/app-runtime-queue.spec.ts`。Evidence. `runtime/evidence/app-runtime/PR-03/diff.patch`.

**Build.**

- [ ] 在同一 PR 把执行目录复制模式切到 App 持久 Workspace：Execution 仍绑定 generation/epoch，封存与关闸仍保留，但不再为每轮复制源码和依赖；只有前轮工具/子进程停止屏障确认后才交给下一轮。交接不得以 `docker exec` 返回或宿主工具停止作为“无后台进程”的证明：shell 进程树由 PR-04 的冻结屏障处理，PR-03 只负责宿主侧文件工具、工作区替换与 authority 交接；两者都完成才允许下一轮。选中旧基线需先在写权限内物化，不能让并行文件工具与 dev server 写入污染快照。Evidence. `runtime/evidence/app-runtime/PR-03/workspace-facts.json`.
- [ ] 接入 queued→唤醒→执行→终态的持久流程；建议队列默认 32、等待 120 秒并受原 Deadline 限制，作为可配置保守初值。排队不取得写权限、不启动模型、不占执行槽；App 上有待执行请求时阻止重复新轮和版本维护冲突，取消/超时原子清理。领取槽位和取得 authority 用短事务校验，重复 requestId 重放；保留独立全局 Generation 上限，槽位不足变排队而非抢占活跃 App。在本 PR 补可控制等待与释放的模型 fixture，使 3 个运行项能持续到队列断言和 RSS 采样完成；取消与释放仍经真实 harness 控制，不直写 Generation 或 authority 状态。该驱动是队列验收的前置，不能留到 PR-04。Evidence. `runtime/evidence/app-runtime/PR-03/queue-facts.json`.
- [ ] 在同一变更迁移所有 generating/building 状态读取、取消、恢复扫描、输入投递、busy 判定、SSE、UI 与压测探针，升级并验证 Next/harness 协议；queued 刷新后仍显示排队，浏览器断连不取消。D1 已确认：只按模型 token 计费；排队、唤醒、安装、命令、构建不新增时间费。实现和测试要保证排队/空闲不产生额外扣款。Evidence. `runtime/evidence/app-runtime/PR-03/state-callers.json`.
- [ ] 所有 buildApp 调用者一次切到统一构建核心，旧导出可作薄适配，删除两阶段 npm 容器和逐字节锁校验；保留已有静态 Preview/Delivery 更新。覆盖工具 self-check、轮末验收、restore rebuild、manual rebuild、部署和测试。旧模板 package-lock 输入在适配层归一为 pnpm 锁，不靠修改已发布模板内容；其余旧类型继续由统一核心构建，直至创建入口退役。Evidence. `runtime/evidence/app-runtime/PR-03/build-callers.json`.

**You see.**

Kind. Behavior.
Surfaces. Web, API.
Interaction. Yes.

- [ ] 3 个正在生成的 App 保持可用，第 4 个显示排队、可取消、刷新不丢；空出槽位后继续生成，同一 Owner 的不同 App 不被单用户串行化。下一轮保留上一轮依赖。Evidence. `runtime/evidence/app-runtime/PR-03/queue-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本分别绕过 requestId 去重/领取原子性、允许 queued 启模型或扣费、禁用取消/重启恢复或 epoch 栅栏、改回每轮复制依赖/旧构建路径；运行下方 generation/harness/delivery/billing integration 命令，要求任务/Charge 唯一、queued 零模型用量、取消无迟到写入/刷新持久、依赖保留及统一构建结果断言失败。以相同 12 App HTTP 驱动再证明超容量反例会被并发上限检查拒绝，不用 mock 事务替代。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-03/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm test`、`npm run test:integration -- tests/integration/generation tests/integration/harness tests/integration/delivery tests/integration/billing`、`npm run test:system -- tests/system/template-build.test.ts tests/system/build.test.ts`、类型和 fast 检查。Pass when 旧终态/计费幂等仍成立，恢复旧版后 package.json/锁/真实依赖一致，重复请求不双排队、断连不失任务、取消后不迟到写入，所有 buildApp 入口均走统一核心。Evidence. `runtime/evidence/app-runtime/PR-03/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧运行同 Owner 多 App 生成、刷新、取消与继续；trunk 无 queued 时记录真实拒绝/准入结果，不假定已有容量上限正确。head 跑 `app-runtime-queue.spec.ts`。Pass when 排队/运行/取消均可见且持久，活跃 App Preview 仍可用。Evidence. `runtime/evidence/app-runtime/PR-03/web/`.
- [ ] Surface. API. 隔离路径用双 Next 提交 12 个不同 App 和重复 requestId，分别触发 Deadline 与重启。默认满队列场景另用 36 个 App，以可控 fixture 保持 3 项运行，观察到 32 项等待后提交第 36 个 App；只读 SQL 对比 Generation、authority、Attempt 和 Charge。等待期间不得让任务提前完成或过期，不能用固定 sleep 假定已排满。开发实例 live 核对页面取消后的 API 状态。Pass when 32 项确实同时等待，第 36 个 App 被可读拒绝且没有新增任务或 Charge，并发永不超配置、每请求最多一任务、无 queued 模型步骤或新增扣费，终态不被旧 epoch 覆盖。Evidence. `runtime/evidence/app-runtime/PR-03/api/`.

**Verify, perf.** Required.

- [ ] Metric. 接收/取消 p95 ms，槽释放到下个任务启动 ms，队列满时进程 RSS MiB，共同 generation p95 s。Evidence. `runtime/evidence/app-runtime/PR-03/perf.json`.
- [ ] Probe. 树外探针 `--scenario queue` 在两侧分别使用相同的 12 App 准入组和 36 App 满队列组，保持 fixture 与 payload 一致。trunk 无队列时记录真实拒绝，不伪造等待指标。head 使用默认 3 槽和 32 条等待容量，先以可控模型 fixture 保持 3 项运行，再提交 32 个不同 App；确认队列满后记录同进程空队列与满队列 RSS、溢出拒绝及取消，保留每项 App/requestId 对应表。缩短 timeout 仅用于单独的过期场景，不能让性能采样时等待项过期。小容量功能测试不替代默认 32 条队列的 RSS 验收。双方另跑共同 generation。Evidence. `runtime/evidence/app-runtime/PR-03/perf-raw/`.
- [ ] Baseline. trunk 先测接收/拒绝和已有成功生成，不把 429 延迟与排队执行耗时作比值。Evidence. `runtime/evidence/app-runtime/PR-03/baseline.json`.
- [ ] Rule. 入队和取消 p95 ≤2000 ms，槽释放后调度 ≤2000 ms；队列满相对同进程空队列 RSS 增量 ≤64 MiB；共同 generation 遵守统一规则。Limit. 2000 ms. Evidence. `runtime/evidence/app-runtime/PR-03/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审排队、唤醒、取消、重连与多 App 的 screenshots 和 video；取得 approval。Evidence. `runtime/evidence/app-runtime/PR-03/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。不接收缺少任何状态消费者/构建入口兼容验证的 PR；核对 D1 已确认口径、原始证据和 head，等待合并授权。Evidence. `runtime/evidence/app-runtime/PR-03/handoff.md`.

## PR-04 开放 shell 并记录构建失败 Version

**Depends on.** PR-03.

**Files.**

Base. PR-03.

Writes. `src/server/generation/tools/shell-tool.ts`、`src/server/runtime/commands.ts`、`src/server/runtime/dependencies.ts`、`src/server/generation/durable/harness-server.ts`、`src/server/generation/durable/effect-gate.ts`、`src/server/generation/durable/faux-fixture.ts`、`src/server/generation/durable/fixture-content.ts`、`src/server/generation/durable-engine.ts`、`src/server/generation/generation-lifecycle.ts`、`src/server/generation/control-store.ts`、`src/server/generation/prompts/generation-instructions.ts`、`src/server/generation/tools/build-preview-tool.ts`、`src/server/versioning/version-store.ts`、`src/server/versioning/version-ledger.ts`、`src/server/infra/schema.ts`、`src/shared/contracts.ts`、`src/shared/versioning.ts`、`src/components/chat/version-panel.tsx`、`src/components/chat/tool-call.tsx`、`tests/unit/generation/**`、`tests/unit/delivery/**`、`tests/unit/chat/**`、`tests/integration/harness/**`、`tests/integration/versioning/**`、`tests/integration/generation/**`、`tests/system/runtime-dependencies.test.ts`、`tests/system/app-runtime.test.ts`、`tests/e2e/app-runtime-shell.spec.ts`、`migrations/*_version_build_status.sql`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-04 独立工作树；真实命令、后台写者、配额与故障 fixture 仅写本轮 App/容器/store；只在隔离副本改故障代码。单写构建状态迁移号；固定联网包版本/registry/锁 hash，完整命令日志留本轮证据目录。

Contract. shell-tool 经 PR-02 runner 消费绑定 App/epoch，harness/effect/budget/UI 同 PR 注册并加载；generation 收束消费统一停止屏障，版本台账生产 pending/passed/failed 与诊断，页面/API 同时消费。文件工具、shell、self-check 和提交使用同一 Workspace 事实，未知 epoch 不得退回 legacy 路径。

- [ ] 新建 `src/server/generation/tools/shell-tool.ts`；修改 `src/server/runtime/commands.ts`、`dependencies.ts`、`generation/durable/harness-server.ts`、`durable/effect-gate.ts`、`durable/faux-fixture.ts`、`durable/fixture-content.ts`、`generation/durable-engine.ts`、`generation-lifecycle.ts`、`control-store.ts`、`prompts/generation-instructions.ts`、`tools/build-preview-tool.ts`、`versioning/version-store.ts`、`version-ledger.ts`、`infra/schema.ts`、`shared/contracts.ts`、`shared/versioning.ts`、`components/chat/version-panel.tsx` 和工具展示相关组件；追加构建状态迁移。更新相关工具/budget/version/generation 测试，新建 `tests/e2e/app-runtime-shell.spec.ts`。Evidence. `runtime/evidence/app-runtime/PR-04/diff.patch`.

**Build.**

- [ ] shell 仅通过 supervisor runner 在绑定 App/epoch 的 runtime 执行，计入 Attempt；默认每命令 120 秒、每 Generation 40 条、输出按 UTF-8 字节截到 8 KiB，完整输出留宿主可诊断的日志，runtime 删除后仍可查摘要。拒绝没有 execution 绑定的 legacy shell。每个命令在独立 session/进程组中执行，但**正常返回也必须跑轮末屏障**：识别并冻结 dev server 树 → 枚举 `/proc` → 对非白名单进程 `SIGSTOP` → `SIGKILL` → 等待非僵尸退出 → 快照。超时、abort、ask、authority 失效、harness 重启走同一屏障；不把杀 Docker CLI、wrapper 返回或 `exec` 关闭当成进程树结束。容器加 `--init`，否则被杀进程会累积成僵尸。Evidence. `runtime/evidence/app-runtime/PR-04/shell-facts.json`.
- [ ] 轮末先跑完屏障并确认 Workspace 在随后 5 秒观察窗口内 hash 不变，再冻结源码、归一锁并校验来源，最后 self-check 和提交；屏障未完成或仍有非僵尸进程时保持 draining，不能封存一个还会变化的目录。任何 shell 都按可能修改源码处理，不依赖 write/edit 工具 dirty 标记。构建失败但合法源码有变更仍提交 Version，写 pending/passed/failed 与限长诊断，失败原因区分模型/安装/构建；有成功 build 也不能覆盖较新源码状态。无源码差异沿用不新增 Version 语义；取消/模型失败仍按现行 Draft 规则，除非另有产品决定。Evidence. `runtime/evidence/app-runtime/PR-04/version-facts.json`.
- [ ] 对整个待提交差异执行 1000 文件/50 MiB/单文件 10 MiB 上限，删除、二进制、未跟踪文件和 shell 写入都计入；拒绝软链接/特殊文件/越界目录，Git add 前先检查，不先把超大对象写进历史再拒绝。超限 Workspace 保留。把封存、Delivery 校验、下载与列表读取从现有 256 文件/16 MiB 限制协调到同一合法源码预算；文本工具 256 KiB 与图片工具 2 MiB 的输入上限可继续存在。Evidence. `runtime/evidence/app-runtime/PR-04/quota-facts.json`.

**You see.**

Kind. Behavior.
Surfaces. Web, API.
Interaction. Yes.

- [ ] Agent 真正装一个固定版本 registry 包并使用；故意引入类型错误后，Version 面板出现 failed 版及诊断，刷新仍存在、文件可读；下一轮修复成功，历史保持线性。超限时清楚提示且源码还在。Evidence. `runtime/evidence/app-runtime/PR-04/shell-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本依次跳过正常返回屏障、恢复 TERM 宽限、去掉 epoch/次数/字节/超时限制、跳过失败源码提交或配额预检；运行下方真实 Docker system 与 harness/versioning integration 命令，要求 detached/忽略 TERM 的 5 秒 hash 稳定、过期写入/第 41 次/8192 bytes/超时、失败 Version 持久及越限不推进 head 断言各自拒绝。旧 256 文件/16 MiB 预算作为合法大源码反例也必须被同一套合法预算检查识别，不能只测拒绝超大文件。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-04/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm test`、`npm run test:integration -- tests/integration/harness tests/integration/versioning tests/integration/generation`、`npm run test:system -- tests/system/runtime-dependencies.test.ts tests/system/app-runtime.test.ts`，再跑类型/fast；增加真实 Docker 的 detached、命令自己 `setsid`、双 fork daemon、忽略 TERM、50 个写者、连续写者、stdout 继承与 2 秒超时用例，以及输出截断、40/41 次、配额边界和冻结后替换文件。Pass when 屏障后 5 秒无新写入、忽略 TERM 也不抢写、超时进程被 KILL、坏构建有 Version、超限不推进 head，合法 50 MiB 范围不会被旧封存预算提前拒绝。Evidence. `runtime/evidence/app-runtime/PR-04/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧用同模型 fixture 引入类型错误，观察旧 Draft/Version 行为；head 通过真实 shell 安装包、失败、刷新、修复。Pass when 失败源码和诊断可见、修复后可预览，不能靠 build stub 或直接写版本行证明。Evidence. `runtime/evidence/app-runtime/PR-04/web/`.
- [ ] Surface. API. 真 harness 工具分别执行 detached 写者、命令自己 `setsid`、双 fork、忽略 TERM、超时、失权、取消和超额调用；只读 API/SQL/Git 核验失败 Version 和历史，读取容器挂载/环境允许名单。Pass when 所有停止路径在屏障后 5 秒无新写入、僵尸不累积、repo 不在容器内且平台密钥未注入；这不构成容器逃逸安全审计结论。Evidence. `runtime/evidence/app-runtime/PR-04/api/`.

**Verify, perf.** Required.

- [ ] Metric. 命令取消到停止 ms，8 KiB 返回体字节，50 MiB 差异预检+提交 s，共同 generation p95 s。Evidence. `runtime/evidence/app-runtime/PR-04/perf.json`.
- [ ] Probe. 树外探针 `--scenario shell`；trunk 记录 shell 缺失并执行共同错误构建/正常生成，head 执行同内容与新命令/配额场景，联网安装单列。Evidence. `runtime/evidence/app-runtime/PR-04/perf-raw/`.
- [ ] Baseline. 先保存 trunk 错误构建和共同 generation；新增 shell 停止与大差异提交只用绝对预算。Evidence. `runtime/evidence/app-runtime/PR-04/baseline.json`.
- [ ] Rule. 取消后停止屏障 ≤5000 ms，返回正文 ≤8192 bytes，50 MiB 差异预检+提交 ≤15 s；共同 generation 满足统一规则。Limit. 5000 ms. Evidence. `runtime/evidence/app-runtime/PR-04/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审安装中/失败提示/failed Version/修复/刷新及限额提示的 screenshots 和 video，取得 approval。Evidence. `runtime/evidence/app-runtime/PR-04/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。核验故障发生在真实命令启动后，停止证据包含 detached/忽略 TERM/50 写者的原始进程清单、5 秒 hash 观察及下一轮内容；检查预算和历史原始证据，等待授权合并。Evidence. `runtime/evidence/app-runtime/PR-04/handoff.md`.

## PR-05 将 Preview 切到 dev server 并保留睡眠回落

**Depends on.** PR-04.

**Files.**

Base. PR-04.

Writes. `src/server/delivery/preview.ts`、`src/server/delivery/delivery-store.ts`、`src/server/delivery/artifacts.ts`、`src/server/runtime/supervisor.ts`、`src/server/runtime/store.ts`、`src/server/business.ts`、`src/shared/contracts.ts`、`scripts/dev/preview.ts`、`src/app/app/chat/[id]/**`、`src/shared/element-selection.ts`、`src/components/chat/generation-feedback.ts`、`tests/unit/delivery/**`、`tests/unit/client/**`、`tests/integration/delivery/**`、`tests/system/preview.test.ts`、`tests/system/preview-rebuild.test.ts`、`tests/system/runtime-preview.test.ts`、`tests/e2e/chat-preview-rebuild.spec.ts`、`tests/e2e/app-runtime-preview.spec.ts`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-05 独立工作树；两 App 的独立 runtime/dev-server 端口共享本轮 Preview origin，全部端口先预留，WS/浏览器上下文按 App 记录；base/head、故障代理与真实产品代理串行，不能占用日常开发实例。

Contract. Preview 生产 HTTP/upgrade 到 App runtime 的同一映射、bridge 注入及隔离响应策略。supervisor 同时提供容器生命周期、dev server 就绪状态及停止原因，不能只用容器 running 判定代理目标。页面和 API 同 PR 消费下方 Preview 状态表，返回实际展示版本。固定 Delivery/Deployment 路由保持不可变。沿用 PR-04 屏障后快照和停止 dev server 的边界，正常空闲走静态回落，不把正常停止标成崩溃。

- [ ] 修改 `src/server/delivery/preview.ts`、`delivery-store.ts`、`artifacts.ts`、`src/server/runtime/supervisor.ts`、`store.ts`、`src/server/business.ts`、`src/shared/contracts.ts`、`scripts/dev/preview.ts`、`src/app/app/chat/[id]/page.tsx` 与样式/元素选择辅助、`src/components/chat/generation-feedback.ts`；更新 `tests/system/preview.test.ts`、`preview-rebuild.test.ts`、`tests/e2e/chat-preview-rebuild.spec.ts`，新建 `tests/system/runtime-preview.test.ts`、`tests/e2e/app-runtime-preview.spec.ts`。Evidence. `runtime/evidence/app-runtime/PR-05/diff.patch`.

**Build.**

- [ ] 按 S2 落地：Vite 用 `--base=/preview/<key>/`，**不要设置 `server.hmr.clientPort` 或 `hmr.port`**（保持 `__HMR_PORT__` 为空，让 HMR 回退到页面/代理端口）；代理 HTTP 与 `upgrade` 共用 App→端口映射，路径不改写，未知 App 拒绝。仅在生成阶段允许实时预览且 dev server 健康时代理 HTTP 与 websocket，平台页面 iframe 在首次 build 前可出现。静态 html runtime 用同一 supervisor 管理的轻量 dev server。容器存活不等于代理可用，冻结、正常停止、暂停、崩溃和睡眠均按下方状态表处理。代理自行注入 bridge、过滤 cookie/敏感响应头并施加 CSP（`connect-src 'self' ws: wss:`），frame-ancestors/Origin 校验沿用隔离来源规则。固定 Delivery/deploy 路由继续服务不可变产物，不跟随 runtime。Evidence. `runtime/evidence/app-runtime/PR-05/proxy-facts.json`.
- [ ] 按 D2 回落最近成功 Delivery，始终返回实际展示版本 A。仅当前版本确实构建失败时，显示“当前版本未通过构建，显示版本 A”；正常结束且当前版本通过构建时，不得显示失败提示。从未成功构建时显示明确空态。正常空闲、暂停、睡眠、收束和 dev server 崩溃分别显示对应状态，不能因容器仍存活就代理已停止的端口。查看或刷新这些状态不启动 Generation/runtime/dev server，也不扣费。Generation 持写权限、暂停或收束未完成时，iframe 可看但不能元素选中或提交可视化编辑，服务端同样拒绝。终态释放权限后可通过静态页桥接发起编辑，按既有输入路径进入下一轮生成。Evidence. `runtime/evidence/app-runtime/PR-05/fallback-facts.json`.

Preview 状态表是本 PR 的路由和页面契约。生命周期与就绪状态分别记录，不把“容器活着”当成一个可代理状态。

| 状态与条件 | HTTP 与 WebSocket | 版本、交互与后续动作 |
| --- | --- | --- |
| 启动中，或生成阶段 dev server 尚未就绪 | 最近成功 Delivery，无产物则空态；不转发 upgrade | 标明正在准备，回落时返回实际版本；不接受可视化编辑 |
| 生成阶段允许实时预览，dev server 健康 | 代理本 App HTTP 与 HMR upgrade | 显示生成中源码，不冒充已提交 Version；只读 |
| 收束中，dev server 冻结或停止，authority 尚未释放 | 最近成功 Delivery，无产物则空态；关闭旧 HMR 连接，不新建 upgrade | 标明正在收束和实际展示版本；只读，不因 GET 重启进程 |
| 正常空闲，容器保留而 dev server 已按轮末流程停止 | 静态 Delivery 回落，无产物则空态；HMR 连接为 0 | 按真实构建状态提示，正常成功不报崩溃或失败；权限已释放时可发起编辑，下一轮才重启 dev server |
| 等待 Question 等暂停状态，dev server 已停止 | 静态 Delivery 回落，无产物则空态；HMR 连接为 0 | 标明暂停及实际展示版本；恢复同一 Generation 时先重新核验 authority，再启动 dev server 并等待健康，不要求另建 Generation |
| 睡眠，容器已回收 | 静态 Delivery 回落，无产物则空态；不代理 upgrade | 显示实际版本；读取不唤醒，下一次有效生成输入才惰性唤醒 |
| dev server 或容器意外退出 | 静态 Delivery 回落，无产物则空态；关闭失效连接 | 显示崩溃原因及实际版本，不冒充正常停止；监督者收束旧执行，下一次有效生成输入按对账结果恢复 |

冻结开始前停止接纳新的 upgrade，结束已有 HMR 连接。下次允许实时预览时等待新的 HTTP 健康检查，再切回实时代理。静态回落切换不得提供混合版本资源；保存切换前后的页面、资源响应与版本事实。原 HMR 单连接预算只针对生成中的实时状态；正常空闲、暂停和睡眠状态必须为 0 条，不靠后台重启维持连接。

**You see.**

Kind. Behavior.
Surfaces. Web, Preview.
Interaction. Yes.

- [ ] 第一轮尚未结束即看到骨架及两次写入后的变化，保持同一个 iframe 观察 HMR。生成结束后容器保留、dev server 正常停止，页面仍显示当前成功 Delivery，刷新不报崩溃，权限释放后可发起编辑。暂停和睡眠也可看已有 Delivery 并看见实际版本提示；刷新不会唤醒或扣费。回答 Question 后，同一 Generation 能重新进入实时预览。Evidence. `runtime/evidence/app-runtime/PR-05/preview-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本分别断开 upgrade、交换两 App 映射、去掉 Cookie/CSP 过滤或持写编辑拒绝、把失败 B 标成旧 A 的内容、允许睡眠 GET 唤醒；运行下方 preview system/delivery integration 和 app-runtime-preview E2E，要求 HMR marker 保留/不串流、哨兵 Cookie 隔离/违规资源拒绝、编辑拒绝、实际版本提示、容器/任务数不增断言各自失败。另分别把正常停止错误标成崩溃、仅按容器 running 代理停用端口、让暂停回复跳过 dev server 健康检查，要求正常空闲仍可看且不报错、失效端口不被代理、同一 Generation 恢复后可见的断言各自拒绝。停 dev server 与冻结边界用真实 Vite 复测，禁止心跳服务替代产品验收。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-05/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm test -- tests/unit/delivery tests/unit/client`、`npm run test:integration -- tests/integration/delivery`、`npm run test:system -- tests/system/preview.test.ts tests/system/runtime-preview.test.ts` 与类型/fast。Pass when HTTP/WS/SPA 子路由正常、跨 App 不串流、Cookie 隔离/CSP 生效；轮末冻结 dev server + 快照 + 停 dev server 后 5 秒无新写入。正常空闲的容器仍存在且 dev server 已停，刷新只读到标明实际版本的 Delivery，HMR 连接为 0，没有崩溃误报或额外唤醒；下一轮或暂停回复重新通过健康检查后 HMR 恢复，崩溃与睡眠也有确定回落。Evidence. `runtime/evidence/app-runtime/PR-05/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧通过开发实例 live 路径打开生成页、首次构建、刷新和元素编辑，记录 trunk 首次 build 前的占位结果。head 录像覆盖生成中多次写入、完成后正常空闲、刷新、编辑、Question 暂停与回复、睡眠再打开。Pass when 修改确实来自本 App 源码，运行中和暂停时不能可视化编辑，正常结束后静态回落可见且可发起下一轮编辑，正常空闲与睡眠访问均不新增任务、容器、dev server 或扣款，暂停回复可恢复同一 Generation 的实时预览。Evidence. `runtime/evidence/app-runtime/PR-05/web/`.
- [ ] Surface. Preview. 真实 Chromium 连 websocket，两个 App 同时更新，访问 SPA 深路径、资源与错误路径；运行中杀 dev server，再执行下一次 Generation；轮末冻结/停 dev server 后检查 5 秒内源码不再变化。Pass when HMR 无全页重载即可看到新内容且页面探针保留、App 不串包，崩溃有提示且重建后恢复，固定 Delivery 内容不变，冻结期间 dev server 不能写。Evidence. `runtime/evidence/app-runtime/PR-05/preview/`.

**Verify, perf.** Required.

- [ ] Metric. 写盘到 iframe 可见 ms、warm Preview TTFB p95 ms、sleep Delivery TTFB p95 ms、10 次 HMR 后 websocket 数。Evidence. `runtime/evidence/app-runtime/PR-05/perf.json`.
- [ ] Probe. 树外探针 `--scenario preview`，以宿主观测写入时刻和 browser DOM marker 时间测差；两侧相同标记页面与已有静态 Preview，trunk 不支持 HMR 单列，绝不使用 head 专有埋点充当 trunk 基线。Evidence. `runtime/evidence/app-runtime/PR-05/perf-raw/`.
- [ ] Baseline. 先测 trunk 静态 Preview TTFB 和已有 rebuild 到可见，head 静态回落与其比较；HMR 仅使用绝对预算。Evidence. `runtime/evidence/app-runtime/PR-05/baseline.json`.
- [ ] Rule. warm 写入到可见 p95 ≤2000 ms，warm/sleep TTFB p95 ≤500 ms，sleep 比 trunk 静态 TTFB 增量 ≤100 ms；10 次更新后每 iframe 仅一条活跃 HMR 连接。Limit. 2000 ms. Evidence. `runtime/evidence/app-runtime/PR-05/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审首次可见、HMR、生成禁编辑、正常空闲刷新与编辑、暂停回复、崩溃、睡眠和实际回落版本提示的 screenshots 与 video，取得 approval。Evidence. `runtime/evidence/app-runtime/PR-05/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。核验 S2 真实代理路径、D2 已确认口径、原始 WS/视频证据、独立来源回归，等待明确合并授权。Evidence. `runtime/evidence/app-runtime/PR-05/handoff.md`.

## PR-06 提供 React 厚模板与二分类创建入口

**Depends on.** PR-05.

**Files.**

Base. PR-05.

Writes. `templates/react-ts/2.0.0/**`、`src/shared/templates.ts`、`src/server/templates/templates.ts`、`src/server/generation/model.ts`、`src/server/generation/prompts/generation-instructions.ts`、`src/server/generation/prompts/harness-instructions.ts`、`src/server/generation/durable/faux-fixture.ts`、`src/server/generation/durable/fixture-content.ts`、`src/server/business.ts`、`src/app/page.tsx`、`src/app/globals.css`、`tests/unit/workspace/templates.test.ts`、`tests/unit/workspace/static-templates.test.ts`、`tests/unit/generation/generation-instructions.test.ts`、`tests/integration/generation/template-generation.test.ts`、`tests/system/template-build.test.ts`、`tests/e2e/home-parity.spec.ts`、`tests/e2e/app-runtime-template.spec.ts`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-06 独立工作树；新模板源码与 pnpm-lock.yaml 由本 PR 独占，平台 package-lock 不因模板装包改变；模板装包和浏览器用本轮隔离 store/账号/viewport，base/head 串行。

Contract. 模板注册表生产 react-ts@2.0.0 和新建可选集，copy loader/resolveTemplate/创建 API/首页/自动路由/提示词同 PR 迁移；旧显式版本仍可读。Vite 入口、路由/组件/令牌和静态资源由模板构建实际加载；只改新增模板，不改已发布模板字节。

- [ ] 新建 `templates/react-ts/2.0.0/`（package.json、pnpm-lock.yaml、Vite/TS 配置、src 入口、路由、令牌、布局、示例数据与 shadcn 源组件）；修改 `src/shared/templates.ts`、`src/server/templates/templates.ts`、`src/server/generation/model.ts`、`prompts/generation-instructions.ts`、`prompts/harness-instructions.ts`、`durable/faux-fixture.ts`、`durable/fixture-content.ts`、`src/server/business.ts`、`src/app/page.tsx` 与关联样式。更新 `tests/unit/workspace/templates.test.ts`、`static-templates.test.ts`、`tests/unit/generation/generation-instructions.test.ts`、`tests/integration/generation/template-generation.test.ts`、`tests/system/template-build.test.ts`、`tests/e2e/home-parity.spec.ts`；新建 `tests/e2e/app-runtime-template.spec.ts`。Evidence. `runtime/evidence/app-runtime/PR-06/diff.patch`.

**Build.**

- [ ] 只向创建者暴露自动、轻量静态和 React 厚架子；自动路由只有明确简单静态需求才选 html，其他默认 react-ts@2.0.0。选择列表与模板注册表分离，resolveTemplate 显式版本仍能读旧 react@1/Vue/multi-file；API 创建校验与 UI 一致，不因隐藏选项就假定旧 API 不会创建旧类型。旧类型读取保留。Evidence. `runtime/evidence/app-runtime/PR-06/routing.json`.
- [ ] 厚模板给出可用布局、颜色/间距/字体令牌、导航路由、带数据的页面和常用 shadcn 源组件；依赖精确锁定初始 pnpm-lock，但后续允许 registry 增改。模板文件清单、copy loader、入口和实际构建产物逐个对应；提示词要求先读并复用组件/令牌，不再四套技术栈分支规则。实施时读取 React 性能技能及前端设计技能；只评模板与创建界面，不扩展成平台重设计。Evidence. `runtime/evidence/app-runtime/PR-06/template-facts.json`.

**You see.**

Kind. Behavior.
Surfaces. Web, API.
Interaction. Yes.

- [ ] 首页选厚模板，新 App 首次 Preview 为有导航和数据的完整页面，移动端可用；轻量模板仍可生成无需构建的单页；刷新后的模板身份与实际文件一致。Evidence. `runtime/evidence/app-runtime/PR-06/template-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本分别把默认改回旧 Vue/React1、重新向创建 API 放行隐藏类型、删一个入口组件/资源或让 loader 漏拷贝、去掉旧显式版本解析；运行下方 workspace/generation unit、template generation integration 和真实 template build/system 命令，要求模板身份/允许集合、实际文件与加载构建、旧版读取断言各自失败。视觉与复用质量由 operator 审真实页面/产物，不声称自动断言证明审美。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-06/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm test -- tests/unit/workspace tests/unit/generation`、`npm run test:integration -- tests/integration/generation/template-generation.test.ts`、`npm run test:system -- tests/system/template-build.test.ts`、类型/fast。Pass when 新模板原样类型检查与构建通过、路由/组件/字体资源可加载，二分类路由与旧显式版本解析均通过。Evidence. `runtime/evidence/app-runtime/PR-06/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧使用同一简单静态提示与相同管理页面提示；记录 trunk 四分类选择和任务清单页面。head 运行厚模板/轻量/自动选择、组件交互、路由、移动端和刷新。Pass when 选项与实际身份一致，厚模板从首次 Preview 即具可用布局且无横向溢出/资源 404。Evidence. `runtime/evidence/app-runtime/PR-06/web/`.
- [ ] Surface. API. 请求新增 templateId、旧 templateId/codeGenType、冲突参数及显式旧版本读取，核验副作用文件。Pass when 创建只产生允许的两种新起点、参数冲突可读拒绝，旧 App 读取不因列表缩减报错。Evidence. `runtime/evidence/app-runtime/PR-06/api.json`.

**Verify, perf.** Required.

- [ ] Metric. 厚模板从唤醒到首次可交互 s、production 首屏 JS gzip KiB、共同 generation p95 s。Evidence. `runtime/evidence/app-runtime/PR-06/perf.json`.
- [ ] Probe. 树外探针 `--scenario templates`，同网络和浏览器 viewport，双方各测当前 React 默认模板；记录不同模板不可作同物比较，另跑共同 html generation；从实际构建 JS 求 gzip 字节。Evidence. `runtime/evidence/app-runtime/PR-06/perf-raw/`.
- [ ] Baseline. 保存 trunk react@1 首屏和 bundle，仅作背景；厚模板新增 UI 用绝对预算，共同 html 依统一规则比较。Evidence. `runtime/evidence/app-runtime/PR-06/baseline.json`.
- [ ] Rule. 热唤醒到厚模板可交互 p95 ≤15 s，首屏 JS gzip ≤350 KiB；共同 generation 不超过 trunk 120% 且 ≤180 s。Limit. 350 KiB. Evidence. `runtime/evidence/app-runtime/PR-06/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审首页选择、厚模板桌面/移动端、导航/组件交互、轻量结果与刷新截图 screenshots 和 video，取得 approval。Evidence. `runtime/evidence/app-runtime/PR-06/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。核验模板内容/loader/产物、二分类实际副作用与媒体，未经 operator 视觉 approval 不合并；继续等待明确 merge 授权。Evidence. `runtime/evidence/app-runtime/PR-06/handoff.md`.

## PR-07 从选定 commit 构建 Deployment

**Depends on.** PR-06.

**Files.**

Base. PR-06.

Writes. `src/server/business.ts`、`src/server/delivery/artifacts.ts`、`src/server/delivery/delivery-store.ts`、`src/server/runtime/**`、`src/server/versioning/version-store.ts`、`src/app/api/[...path]/route.ts`、`src/shared/versioning.ts`、`src/components/chat/version-panel.tsx`、`src/app/app/chat/[id]/page.tsx`、`src/client/api.ts`、`tests/integration/delivery/deployment-record.test.ts`、`tests/integration/delivery/publish-vue-build.test.ts`、`tests/integration/delivery/download-delivery.test.ts`、`tests/integration/versioning/**`、`tests/unit/delivery/**`、`tests/e2e/app-edit-publish-verify.spec.ts`、`tests/e2e/version-delivery-verify.spec.ts`、`tests/system/platform-build.test.ts`、`tests/e2e/app-runtime-deploy.spec.ts`、`scripts/verify/app-runtime-probe.mjs`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-07 独立工作树；Version/Workspace 放置不同内容哨兵，一次性容器/staging/deploy key 只属本轮 App；持续 GET 与故障进程只触及本轮部署目录，遵守 PR-02 一次性构建准入预算，不使用真实公开站点。

Contract. business.publish/app/deploy 生产选定 Version SHA 的部署请求，页面、client 和 route 同 PR 兼容；统一构建核心消费 commit 物化目录，Delivery/deploy/cover/download 消费绑定产物。当前版本检查控制 Preview 指针更新；Generation 内 publishGeneration 不受混接，旧 Deployment 原子保留。

- [ ] 修改 `src/server/business.ts`、`src/server/delivery/artifacts.ts`、`delivery-store.ts`、`src/server/runtime/` 的统一构建与一次性容器适配、`src/server/versioning/version-store.ts`、`src/app/api/[...path]/route.ts`、`src/shared/versioning.ts`、`src/components/chat/version-panel.tsx`、`src/app/app/chat/[id]/page.tsx` 和 `src/client/api.ts` 中受影响请求；更新 `tests/integration/delivery/deployment-record.test.ts`、`publish-vue-build.test.ts`、`download-delivery.test.ts`、`tests/e2e/app-edit-publish-verify.spec.ts`、`version-delivery-verify.spec.ts`；新建 `tests/system/platform-build.test.ts`、`tests/e2e/app-runtime-deploy.spec.ts`。Evidence. `runtime/evidence/app-runtime/PR-07/diff.patch`.

**Build.**

- [ ] 明确本 spec 的 Publish 对应 UI「部署」与 `business.publish` / `app/deploy`；不将它误接到 Generation 内部 `publishGeneration`。部署请求绑定选定 Version（缺省当前 head），在 claim 事务核验 App/Version/权限并记录 SHA；仅从该 commit 物化到一次性目录，按锁文件 frozen install+typecheck+build，复用同一构建核心，禁止读活 Workspace 或唤醒常驻 runtime。Evidence. `runtime/evidence/app-runtime/PR-07/source-facts.json`.
- [ ] 成功产物创建不可变 Delivery，更新所部署 Version 的可用回落；只有它仍为当前 Version 时才推进当前 Preview 指针。复用 deploy key，以完整新目录原子替换 Deployment；失败/取消/崩溃保留上个部署。download/cover 取所绑定产物，不能用 runtime dist 代替。所有新增请求参数调用者、维护锁、重复 requestId 和故障收尾同 PR 兼容。Evidence. `runtime/evidence/app-runtime/PR-07/deploy-facts.json`.

**You see.**

Kind. Behavior.
Surfaces. Web, Deployment, API.
Interaction. Yes.

- [ ] runtime 睡眠时部署 A 成功且没被唤醒；Workspace 写着 B 仍只部署 A；部署坏版本 C 失败，原 URL 继续显示 A；恢复 A 产生 D 后可再部署，刷新保留结果。Evidence. `runtime/evidence/app-runtime/PR-07/deploy-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本把输入改回活 Workspace、允许旧 SHA 构建推进当前 Preview、失败时提前切指针或绕过去重；运行下方 deployment/versioning integration、platform-build system 命令及持续 GET 驱动，要求 commit 内容/锁哨兵、版本回落不串、旧 URL 完整可用、重复请求单次副作用断言各自失败。崩溃分别注入真实产物安装后/指针响应前和目录切换后，不能在请求未执行时终止冒充恢复验证。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-07/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 运行 `npm run test:integration -- tests/integration/delivery tests/integration/versioning`、`npm run test:system -- tests/system/platform-build.test.ts`、`npm test -- tests/unit/delivery`、类型/fast。Pass when build 只读 commit、依赖符合该版锁、sleep 可部署、部署失败和重复请求不改变旧站点，staging 容器和目录被正确回收。Evidence. `runtime/evidence/app-runtime/PR-07/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧操作已有部署→失败→重试→刷新；记录 trunk 的真实 Workspace 来源，head 另跑睡眠/指定旧版部署。Pass when 状态可读、旧站点持续可访问，head 请求确实绑定选定 SHA。Evidence. `runtime/evidence/app-runtime/PR-07/web/`.
- [ ] Surface. Deployment. 外部浏览器持续读 deploy URL，在构建中、产物安装后指针更新前、目录切换后分别终止本轮测试进程。Pass when 每次只看到完整 A 或完整新产物，坏构建永不切换，恢复后同 requestId 不重复部署。故障必须发生在真实副作用后，不能用阻止请求发送冒充。Evidence. `runtime/evidence/app-runtime/PR-07/deployment/`.
- [ ] Surface. API. `app/deploy` 重复、越权、旧 SHA、当前 SHA 改变竞争，配合只读 SQL/Git 与下载检查。Pass when 审计 SHA/锁/Delivery/内容一致，不从活 Workspace 混入文件、不改变其他版本回落。Evidence. `runtime/evidence/app-runtime/PR-07/api.json`.

**Verify, perf.** Required.

- [ ] Metric. 固定模板部署端到端 s、构建期间旧站点 TTFB p95 ms、并发部署容器数。Evidence. `runtime/evidence/app-runtime/PR-07/perf.json`.
- [ ] Probe. 树外探针 `--scenario deploy`，双方同模板包集、同成功内容/失败类型错误，持续 GET deploy URL；trunk 不支持睡眠/commit 绑定记录缺失，head 单独测绝对预算。Evidence. `runtime/evidence/app-runtime/PR-07/perf-raw/`.
- [ ] Baseline. trunk 先录现有完整部署时长和旧 URL 可用性；不同安装方式不承诺加速比。Evidence. `runtime/evidence/app-runtime/PR-07/baseline.json`.
- [ ] Rule. 既有镜像与可用 registry 下固定模板一次部署 ≤180 s，旧站点 TTFB p95 ≤500 ms 且不高于 trunk 120%，故障过程中成功 GET 比例 100%；并发不超 PR-02 的已配置预算。Limit. 180 s. Evidence. `runtime/evidence/app-runtime/PR-07/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审睡眠部署、坏版本失败但原链接正常、恢复后再部署的 screenshots 和 video，取得 approval。Evidence. `runtime/evidence/app-runtime/PR-07/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。逐项核验选定 SHA、原子产物切换、旧站点连续读取和故障位置原件，精确 head 达 merge-ready 后等合并授权。Evidence. `runtime/evidence/app-runtime/PR-07/handoff.md`.

## PR-08 完成管理、删除与切换收尾

**Depends on.** PR-07.

**Files.**

Base. PR-07.

Writes. `src/app/admin/runtimeManage/page.tsx`、`src/components/runtime/**`、`src/app/api/[...path]/route.ts`、`src/server/business.ts`、`src/server/runtime/**`、`src/server/infra/schema.ts`、`src/components/providers.tsx`、`src/server/versioning/version-store.ts`、`scripts/ops/reset-app-runtime.ts`、`package.json`、`tests/integration/platform/**`、`tests/system/app-runtime.test.ts`、`tests/e2e/app-runtime-admin.spec.ts`、`tests/e2e/app-runtime-journey.spec.ts`、`scripts/verify/app-runtime-probe.mjs`、`../GLOSSARY.md`、`../PRODUCT.md`、`docs/implementation-contract.md`、`docs/specs/app-runtime.md`、`docs/plans/app-runtime.md`、`docs/plans/archive/app-runtime.md`、`docs/plans/archive/README.md`、`docs/plans/capacity-streaming-sandbox-queue.md`、`docs/adr/*.md`、`../.pi/skills/verify-paimeng-agent/features/**`。路径相对产品目录；仅当期 PR 独占，下个 PR 在前序合入后接续。

Resources. PR-08 独立工作树；管理员/普通用户各用唯一测试账号，清理演练仅允许本轮 _test App 白名单；只删 App 私有 virtual store 子目录，共享包存储保留。真实存量仅准备 dry-run/备份清单，不 apply。根文档、ADR 下一空编号及计划移动/引用修复由本 PR 单写；本机功能地图单独记录未入库边界。

Contract. admin API 生产 runtime 列表/回收/诊断，页面导航/权限同 PR 加载；deleteApp 经 supervisor 确认停止后收尾全部关联资源，错误可重试且保护账本。一次性 CLI 用同一清理边界并校验数据库/目录/目标清单；全链验收后由文档/ADR 接手稳定契约，不把计划归档当业务实现证据。

- [ ] 新建 `src/app/admin/runtimeManage/page.tsx` 与 `src/components/runtime/` 管理组件；修改 `src/app/api/[...path]/route.ts`、`src/server/business.ts`、`src/server/runtime/`、`src/server/infra/schema.ts`、`src/components/providers.tsx`、`src/server/versioning/version-store.ts`；新建一次性 `scripts/ops/reset-app-runtime.ts` 并在 `package.json` 注册待清理入口；更新 `tests/integration/platform/`、`tests/system/app-runtime.test.ts`，新建 `tests/e2e/app-runtime-admin.spec.ts` 与 `app-runtime-journey.spec.ts`。更新仓库根 `GLOSSARY.md`、`PRODUCT.md` 及产品内 `docs/implementation-contract.md`、`docs/specs/app-runtime.md`、本计划及旧容量计划；最多三份新增 ADR 记录 runtime 边界、版本历史、commit 构建的长期决定。Evidence. `runtime/evidence/app-runtime/PR-08/diff.patch`.

**Build.**

- [ ] 管理员看 App/runtime 状态、槽位、容器标识、最后活动/命令与崩溃诊断，可回收空闲 runtime；生成持写权限时不得强行回收，给可读忙原因，普通用户无权访问。正常删除走 supervisor 停止/确认→删除拥有的文件和关联资源→完成标记，失败可重试，不能仅软删 App 后吞掉清理错误。用户/余额/Charge/账本保留。Evidence. `runtime/evidence/app-runtime/PR-08/admin-delete.json`.
- [ ] 先在 `_test` 演练清理脚本 dry-run/apply/no-op：显式 App 清单、目录白名单、引用与金额不变量，删 Workspace、外置版本库、执行/快照、Delivery、Deployment、Cover、上传与相关 App 数据，不删除共享 store 中其他 App 仍需内容。真实存量 apply 在新链全验收且 operator 另行批准具体目标后执行，不因批准本计划就执行。完成后删除一次性脚本和 npm 入口，仅保留迁移记录。Evidence. `runtime/evidence/app-runtime/PR-08/reset-rehearsal/`.
- [ ] 核对规格 42 故事到 PR/测试/证据的覆盖表，补真实全链路并删除遗留生产构建链；旧容量计划仅替换被本 spec 取代的构建队列/沙箱章节，不把其未解决的准入、流式背压问题误标完成或整体归档。更新冲突术语/实现契约，规格最终 supersede，计划完成后按 docs 规则归档并修全部引用。Evidence. `runtime/evidence/app-runtime/PR-08/acceptance-map.md`.

**You see.**

Kind. Behavior.
Surfaces. Web, API, CLI.
Interaction. Yes.

- [ ] 管理页看得到槽位与崩溃原因，可回收空闲 App；下一条用户消息自动唤醒。删除后全部 App 资源消失，刷新列表不再出现，保留用户账单可审计。Evidence. `runtime/evidence/app-runtime/PR-08/admin-journey/`.

**Verify, unit.** Required.

Sensitivity. 在隔离故障副本分别移除管理权限/活动写者保护、让清理漏删一类资源或吞错、允许 dry-run 写入/越界目标、删改账本哨兵；运行下方 platform integration、app-runtime system 与隔离 CLI/E2E，要求越权/忙拒绝、完整资源清单/失败重试、dry-run 前后零变更/目标外零变更、账本摘要不变断言各自失败。对每类资源至少留一项真实残留反例，不能只断言 App 行不存在。 所有反例只在隔离副本运行，保留故障 diff、同一断言的预期失败与恢复 head 后通过的结果到 `runtime/evidence/app-runtime/PR-08/sensitivity/`；后续新增关键不变量同样列明反例与拒绝检查，不改断言求绿。

- [ ] 顺序运行 `npm test`、`npm run test:integration`、`npm run test:system`、`npm run type-check`、`npm run check:fast`、`npm run build`；隔离 E2E 跑新旅程与相关旧 specs。Pass when 必需用例通过、删除可重试和账本不变量成立，全部构建入口仅一份核心实现，42 故事均有绑定当前版本的实际通过证据。未完成项另列为阻塞，即使覆盖表已填完整也不能判本 PR 通过。Evidence. `runtime/evidence/app-runtime/PR-08/checks.log`.

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 两侧完整创建/生成/版本/部署/删除，记录 trunk 遗留资源的实际情况；head 新旅程覆盖安装、实时预览、坏版本、sleep/唤醒、恢复与管理。Pass when UI/真实副作用一致，刷新/重试成立，没有孤儿资源或无授权管理入口。Evidence. `runtime/evidence/app-runtime/PR-08/web/`.
- [ ] Surface. API. 普通用户/管理员分别调用 runtime 列表、回收、删除，制造停止和文件清理失败再重试。Pass when 权限正确、活动写者受保护、清理失败不伪报成功，重试后无容器和 App 私有目录残留且账本不变。Evidence. `runtime/evidence/app-runtime/PR-08/api.json`.
- [ ] Surface. CLI. 对隔离 fixture 运行清理脚本 dry-run、明确清单 apply、重复 apply、错误数据库/路径；观察前后 SQL、目录与账本摘要。Pass when dry-run 零变更，目标外数据零变更，apply 幂等且报告完整，错误目标在副作用前拒绝。Evidence. `runtime/evidence/app-runtime/PR-08/cli/`.

**Verify, perf.** Required.

- [ ] Metric. 管理列表 p95 ms、删除/回收耗时 s、完整旅程端到端 s、循环唤醒后常驻匿名内存 MiB。Evidence. `runtime/evidence/app-runtime/PR-08/perf.json`.
- [ ] Probe. 树外探针 `--scenario delete`，双方相同 12 App 清单与相同文件量，trunk 无管理页记 unsupported；head 10 轮唤醒/生成/睡眠，记录实际 cgroup anon，排除 page cache。Evidence. `runtime/evidence/app-runtime/PR-08/perf-raw/`.
- [ ] Baseline. trunk 先测旧删除响应与实际遗留；head 只在资源清理完成才停止计时，不能以快但未清理的旧响应作为等价比值。Evidence. `runtime/evidence/app-runtime/PR-08/baseline.json`.
- [ ] Rule. 12 App 管理列表 p95 ≤1000 ms；每 App ≤50 MiB 源码且依赖已装时回收/清理 ≤30 s；10 轮后空闲 runtime 匿名内存仍在 PR-02 上限，完整旅程非联网步骤 ≤300 s。Limit. 30 s. Evidence. `runtime/evidence/app-runtime/PR-08/perf-verdict.md`.

**Review gate.** Required.

- [ ] operator 审管理列表、忙时回收、崩溃诊断、删除确认/失败重试、最终全旅程的 screenshots 和 video，取得 approval；这不等于批准清空真实存量。Evidence. `runtime/evidence/app-runtime/PR-08/review.md`.

**Merge.**

Verifier. Independent.

- [ ] 记录真实 PR URL、`/opening-a-pr` 正文及当前 base/head；取得非作者 `/verify-pr` 的 PASS/PASS+NOTES、必需 CI/审阅和适用交互 approval，任一验收未满足均保持 pending/FAIL/BLOCKED。核验所有证据、真实清理批准范围（如尚未批准则切换操作保持待执行）、ADR/计划归档引用和原始测试结果；只在 operator 明确授权后合并，不自动执行真实 apply。Evidence. `runtime/evidence/app-runtime/PR-08/handoff.md`.

## Close the program

实施完成条件是 42 故事覆盖表全部满足，而非八个 PR 有了编号。列出每 PR 的真实 URL、精确已验证 SHA、原始证据和 operator 审阅记录；未满足的场景、联网跳过和真实模型未测边界单列。

先在新路径和隔离数据完成验收，再准备真实存量 dry-run 清单、备份/恢复步骤与切换窗口。实际删除必须另获明确批准；若未获批准，报告“代码 merge-ready、真实数据切换待批准”，不能宣称上线完成。删除前可回滚代码并保留数据；删除后恢复依赖事先验证过的备份，不能靠旧代码找回数据。

本文完成或被取代时移至 `docs/plans/archive/app-runtime.md`，更新 archive 索引、规格/产品链接；未完成的容量与传输工作仍保留原计划当前状态。

## Appendix A. Spike evidence

实验于 2026-11-03 完成，基线为 `13ef405b092afe704776ed8a4f0dd736457800ae`。原件未入库，只存在于主检出的未跟踪工作树；2026-11-04 已按附录 D 路径还原到本工作树，逐文件 SHA-256 记录在 `runtime/evidence/app-runtime/preflight/spikes.md`。

以下 S1/S2/S3 数值、环境和技术选择已用 `verify-spikes.mjs` 从原始 JSON 复现，41 项断言全部通过。它们证明 2026-11-03 那次运行的结果，不证明本机之外的环境，也不替代各 PR 在自己版本上的复测。D1/D2 是已确认产品口径。

环境：`paimeng-app-runtime:1894779bd433`（本地标签，Node 24.22.1、pnpm 10.18.3、git 2.54、Docker 29.8.2），宿主 uid 1000，Workspace 与 store 在同一宿主文件系统。镜像是本地标签，不是 digest 固定的生产镜像；绝对 MiB 只对本机和该镜像成立。

**S1：pnpm 跨挂载。** 两个独立 bind mount 之间 `link()` 返回 `EXDEV`；两个挂载的 `stat -c %d` 都是 `66308`，所以不能用 `st_dev` 判断硬链接可行。默认 virtual store（`/work/node_modules/.pnpm`）让 store 与 Workspace 各占约 65 MiB，合并 129.5 MiB。把 virtual store 放到 `/store/apps/<key>/.paimeng-virtual` 后，Workspace 只占 0.1 MiB，合并 65.2 MiB；第二个 App 只追加 0.25 MiB；两个 App 的同一 `react/index.js` 为 `66308:3155809:3`（同 inode、nlink=3）。两个 App 并发安装都成功；容器以 uid 1000 写出的文件宿主可直接删除。**决定：** 保留两个 mount；平台安装与模型 shell 都设置 `npm_config_virtual_store_dir=/store/apps/<key>/.paimeng-virtual`；`node_modules` 留在 Workspace，只是指向 virtual store 的符号链接；删除 App 时删该 App 的 store 子目录。**否决：** 默认 `.pnpm`（磁盘翻倍）、一个父挂载暴露所有 App 目录。

**S2：HMR 子路径代理。** 真实 Vite 7 + 最小 HTTP/WS 代理 + Chromium：5 次 HMR 为 56/59/61/59/56 ms，页面 `window.__probe` 保留（未整页刷新）；HMR WebSocket 为 `ws://127.0.0.1:3101/preview/react_project_.../?token=...`，收到 update 帧；两个 App 不串流；SPA 深链 200；`pageErrors`、`requestFailed`、`consoleErrors` 均为 0。**决定：** Vite 用 `--base=/preview/<key>/`；代理同时处理 HTTP 与 `upgrade`，路径不改写；**不要设置 `server.hmr.clientPort` 或 `hmr.port`**，让 `__HMR_PORT__` 为空并回退到页面/代理端口；CSP 允许 `ws:`/`wss:`。**局限：** spike 代理不是产品 `preview.ts`，Cookie、Host、编辑桥接、生产 CSP 仍由 PR-05 证明。

**S3：shell 后台写入。** 真实容器中复现了远端 `shell.ts` 的 `setsid` + 进程组看门狗。发现：(1) wrapper 正常返回只杀看门狗，不杀进程组；detached 写者（`setsid ... >/dev/null 2>&1 &`）在返回后继续写。(2) 后台进程继承 stdout 时，`docker exec` 会被拖到它退出（1.5 s 写者让 exec 1548 ms 才返回；20 s 写者只能等 2 s 超时）。(3) 先 TERM 再 KILL 的 800 ms 宽限期会让忽略 TERM 的 shell 在其 `sleep` 子进程被 TERM 后立刻执行下一句 `echo`，抢写成功。改成“先 SIGSTOP 全部非白名单进程，再 SIGKILL”后：detached、双 fork、忽略 TERM、50 个写者、连续写者全部在屏障后稳定；屏障耗时 8–47 ms（50 个写者 47 ms）；冻结 dev server 时心跳不变、`SIGCONT` 后恢复、`/ping` 200。无 `--init` 的容器 20 个被杀进程留下 20 个僵尸；`--init` 为 0。整容器 `docker kill` + `start` 为 98/95 ms，无迟到写入，但 dev server 不自动恢复。**决定：** 每轮收束（成功、失败、取消、ask）都跑屏障：冻结 dev server 树 → `SIGSTOP` 非白名单 → `SIGKILL` → 等待退出 → 快照 → 停 dev server；下一轮在同一容器重启 dev server。容器加 `--init`。不把 wrapper 返回、`exec` 关闭或杀 Docker CLI 当作进程树结束。整容器 kill/start 作为兜底。

**D1（已确认）：** 只按模型 token 计费；“Generation 窗口”只表示归属该轮的实际模型用量。排队、唤醒、安装、命令、构建不新增时间费。**D2（已确认）：** runtime 回收后显示最近成功 Delivery，并标明“当前版本未通过构建，显示版本 A”；绝不把 A 内容标成失败版 B；从未成功构建时显示明确空态。

**与远端分支的关系。** `origin/agent/app-runtime-136-144`（#137–#144）已包含 runtime、shell、Preview 代理和排队实现；其 `plan.ts` 已采用 virtual store 绕法，`preview.ts` 已注册 `upgrade`，`system/app-runtime.test.ts` 用真实 Docker + Vite 测过 HMR。但该分支的 `integration/harness/shell-tool.test.ts` 明确不启动 Docker，`shell.ts` 只在超时分支杀进程组，`runtimeRunArgs` 没有 `--init`；S3 补上了这三处。分支代码不是本次结论的唯一依据，也不能把“S3 已解决”建立在它上面。

**未证明：** 真实 Vite 插件在 `SIGSTOP`/`SIGCONT` 或 dev server 重启边界的行为；产品 `preview.ts` 的 Cookie/Host/CSP/编辑桥接；多用户 store 隔离、磁盘配额、网络故障、镜像升级、Postgres 队列/槽位；真实模型的 shell 使用模式；冷安装时间（本次多数命中预热 store）。

## Appendix B. Alternatives rejected

下列涉及 S1/S2/S3 的实验数值和取舍来自旧计划，目前只保留为历史候选依据。先按 B1 核验原始产物，再确认可复用的技术选择；不得据此宣称技术前提已关闭。

- 每 Generation 都新建目录/新容器：当前实现如此，但无法满足跨轮依赖保留与实时页面，目标改成每 App 稳定 Workspace/runtime；保留 Execution/epoch 和快照作为控制事实，不能删掉写权限机制。
- 把 Git worktree 解释成必须运行 `git worktree add`：该命令会在挂载根留下 `.git` 文件；选择外置裸库加宿主显式 `--work-tree` 的源码目录，避免容器获得历史写入口。此结论来自现有 version-store 已使用的临时索引/commit-tree 能力，不需再做 Git 基础原型。
- 继续维护原型的 npm 依赖白名单/断网 build 双链：与开放依赖冲突；统一 install/typecheck/build 核心，runtime self-check 与一次性 platform build 只在执行环境和输入来源不同。
- 把 registry-only 当出网隔离：spec 已明确网络放开。manifest、overrides 和锁文件校验仅证明声明来源；shell 和安装脚本仍可能联网，不能把它宣传成只会访问 registry。
- 整体归档旧容量计划：它仍有准入竞争和流式背压事项，本工作仅取代其构建队列/沙箱部分。
- 两个 mount 里用默认 `/work/node_modules/.pnpm`：`link()` 跨 mount EXDEV，pnpm 复制，store 与 Workspace 各一份，spike 实测合并 129.5 MiB vs 65.2 MiB。
- 把 Workspace 与 store 放进一个父挂载：硬链接可行，但容器能看到其他 App 的目录；除非另做 per-App 视图，否则不采用。
- 先 TERM 再等 grace：忽略 TERM 的 shell 会在其 `sleep` 子进程被 TERM 后立刻执行下一句写入；必须 SIGSTOP 后再 SIGKILL。
- 把 `docker exec` 返回、wrapper 返回或杀 CLI 当作进程树结束：detached 写者与双 fork daemon 都会逃逸；轮末屏障必须独立运行。
- 用整容器 kill/start 作为主路径：98/95 ms、绝对干净，但 dev server 不自动恢复，Preview 在轮间断；保留为兜底，不作为默认。
- 给 Vite 设置 `server.hmr.clientPort`/`hmr.port`：HMR 会指向 dev server 端口而不是代理端口，浏览器直连失败；只传 `--base`。

## Appendix C. Risks

- R1 / PR-02：S1 历史摘要提出将 virtual store 放在 store mount 内以避免跨挂载 EXDEV，原始证据须先通过 B1。共享 store 的可写面与多用户隔离仍是边界，本轮只支持约定的单用户共享，第二用户的 store 隔离不在范围；platform/system 用例必须实际证明第二 App 增量与同 inode。
- R2 / PR-03/04：开放 shell 后旧“关文件工具门”不再阻止后台写。S3 历史摘要提出 SIGSTOP→SIGKILL 屏障，detached、双 fork 和忽略 TERM 的效果均待原始证据核验。屏障未完成时必须保持 draining。PR-04/05 还须用真实 Vite 证明冻结与重启边界，收束时停掉 dev server，正常空闲按 PR-05 状态表回落。
- R3 / PR-03：当前 acquireAuthority 按 Execution 计并发，初始化存在容量空窗；队列领取必须原子预留，不能只包一层等候再调用旧函数。数据库不可用时不得启动新容器。
- R4 / PR-04：旧限制为 256 文件/16 MiB，spec 提交限额为 1000/50 MiB/10 MiB；只改 Git 会让 snapshot/download/Delivery 提前失败。分别区分工具输入上限、提交差异与产物上限，不把 dist 打包上限盲目当源码限额。
- R5 / PR-05：S2 历史摘要记录 Vite 7、Chromium、`--base` 和 HTTP/WS 代理的观察，原始时间样本与浏览器事实须先通过 B1。产品 `preview.ts` 的 Cookie/Host/CSP/编辑桥接、真实模板及正常停止后的回落仍须由 PR-05 的 system/E2E 和开发实例 live 证明。
- R6 / PR-07：当前 business.publish 的 versionSha 只是审计，来源还是 Workspace；必须证明构建读取的就是 commit，且产物切换原子。仅看 deployment 行 SHA 不足以验收。
- R7 / PR-08：当前 deleteApp 只软删、删 Generation 和 purgeVersions，缺完整资源清理；真实存量删除不可逆。计划不授权执行，先提供审过的 dry-run/备份及隔离演练，后申请具体 apply。
- R8 / PR-06：厚模板的审美与页面结构未有已批准原型，不预设“好看”已验证；实施交互评审不通过就修改模板，不靠测试绿替代人工审阅。
- R9 / 全程：现有 faux fixture 不足以覆盖 shell、持久等待、错误构建和中间 HMR。PR-03 先交付队列所需的可控模型等待与释放，PR-04 再扩展真实 shell 和错误构建工具输出，PR-05 复用并补中间 HMR 驱动。禁止用测试 API 直写内部状态，驱动缺失即对应 PR 验收未完成。联网 unavailable 时装包功能证据保持未完成。
- R10 / PR-02/07：常驻 3 槽不等于总机器容器上限，一次性部署也占 CPU/磁盘；统一资源准入与独立槽预算必须在 system 并发用例中同时验证。cgroup memory.current 含 page cache，预算与诊断使用 anon，不能据总缓存占用误杀。
- R11 / 全程：调查时根术语表与 implementation-contract 有部分旧语义，实际代码优先。规格页同时写“已发布 #136”和“待评审后发布”，本轮不发 issue、不补标签；PR-08 对齐真实状态。已有两份 ADR-0006，新增 ADR 使用当时下一空编号，不重写旧编号。
- R12 / PR-02/04：历史摘要记载无 `--init` 为 20 个僵尸、有 `--init` 为 0，数字待 B1 原始证据核验。容器必须加 `--init` 或自带 tini，并以当前实现实际断言僵尸数不随轮次增长。
- R13 / PR-04：历史摘要记录后台进程继承 stdout 会拖住 `docker exec`，其时长样本待 B1 原始证据核验。命令超时必须覆盖这种情况，轮末屏障不能依赖 wrapper 或 exec 返回。
- R14 / PR-02/05：spike 镜像是本地标签，冷安装多数命中预热 store；生产镜像要 pin digest，预算要用冷安装和同机基线重测，不能拿本次热数据冒充。
- R15 / PR-04/05：真实 Vite 插件可能在冻结或 dev server 重启时写缓存或源码。收束时停 dev server，用真实 Vite 的 system 用例验证 5 秒 hash 稳定；正常空闲与暂停期间不代理停用端口。下一轮生成或同轮 Question 回复时重新核验 authority 和健康，再恢复实时预览，GET 不触发重启。

## Appendix D. Links and decisions

原件已于 2026-11-04 按下列路径还原，逐文件 SHA-256 与核验方法见 `runtime/evidence/app-runtime/preflight/spikes.md`。原件放在别处时更新为实际可访问的位置。

| 原产物 | 路径 | 当前状态 |
| --- | --- | --- |
| 复现入口 | `docs/prototypes/in-progress/app-runtime/README.md` | 已还原，hash 已记录 |
| 完整报告 | `docs/prototypes/in-progress/app-runtime/report.md` | 已还原，hash 已记录 |
| S1 脚本 | `docs/prototypes/in-progress/app-runtime/spike/s1-hardlinks.mjs` | 已还原，hash 已记录 |
| S2 脚本 | `docs/prototypes/in-progress/app-runtime/spike/s2-hmr-proxy.mjs` | 已还原，hash 已记录 |
| S3 脚本 | `docs/prototypes/in-progress/app-runtime/spike/s3-stop-barrier.mjs` | 已还原，hash 已记录 |
| 原始 JSON、截图与进程事实 | `docs/prototypes/in-progress/app-runtime/evidence/` | 已还原，41 项断言复现通过 |

调查入口（行号以调查 SHA 为准）：

- [business.ts](../../src/server/business.ts)：createApp 51、deleteApp 84、restoreAppVersion 215、publish 310；前端「部署」经 [业务 API](../../src/app/api/[...path]/route.ts) 的 app/deploy 调用 publish。
- [generation-lifecycle.ts](../../src/server/generation/generation-lifecycle.ts)：startGeneration 625 创建隔离执行目录、publishReady 1070 验证后发布、failOrCancel 的 Draft 封存路径。 [execution-workspace.ts](../../src/server/workspace/execution-workspace.ts) 负责每轮目录和停止/封存边界。
- [control-store.ts](../../src/server/generation/control-store.ts)：acquireAuthority 223、全局容量 240、reserveAttempt 783；锁顺序 app→authority→generation→attempt，不能另加逆序锁族。
- [version-store.ts](../../src/server/versioning/version-store.ts)：versionRepo 48 位于 Workspace/.git，prepareCommitLocked 已有临时索引与 commit-tree，restoreVersion 735 附近为 detached HEAD。 [git-tool.ts](../../src/server/generation/tools/git-tool.ts) 64 直接拼 Workspace/.git；不能只改 versionRepo。
- [artifacts.ts](../../src/server/delivery/artifacts.ts)：buildApp 143、锁逐字节校验 174、npm install/断网构建 192–200。 [templates.ts](../../src/server/templates/templates.ts) 依赖固定白名单；[build-contract.ts](../../src/server/delivery/build-contract.ts) 对名称和版本双重限制。
- [preview.ts](../../src/server/delivery/preview.ts)：当前只有 GET/HEAD 静态文件，未注册 upgrade；CSP connect-src self。 [生成页面](<../../src/app/app/chat/[id]/page.tsx>) 已有生成中 badge，但首次 Preview 的 canPreview 仍依赖构建结果。
- [model.ts](../../src/server/generation/model.ts)：routeCodeGenType 22，fixture 和真实路由均四分类，复杂默认 Vue。 [模板注册表](../../src/shared/templates.ts) 是首页选择和 resolveTemplate 共用来源。
- [settlement.ts](../../src/server/billing/settlement.ts)：completeChargeTx 只定价 model token 步骤，build/summary 不计；[workspace.ts](../../src/server/workspace/workspace.ts) 14–18 是现有文件/总量限制。
- [harness-server.ts](../../src/server/generation/durable/harness-server.ts)：工具注册、effect hook、预算 hook 一起维护；[effect-gate.ts](../../src/server/generation/durable/effect-gate.ts) 目前只在工具调用前验权限，不监督容器后台进程。

执行前置阅读：PR-01/03/04 阅读 [server 边界](../../src/server/AGENTS.md)、[现有实现契约](../implementation-contract.md) 和 [术语表](../../../GLOSSARY.md)；PR-02/07 阅读 [脚本规则](../../scripts/AGENTS.md)、[测试资源边界](../../tests/AGENTS.md)、[vitest 配置](../../vitest.config.ts) 和 [隔离 launcher](../../scripts/verify/test-e2e.ts)；所有 UI PR 实施时读取项目 Next 文档与适用 React/设计技能。应用依赖继续使用 npm，本次 pnpm 切换对象是生成 App，不能顺手更换平台包管理器。

B2 的外部工具包原位置为仓库根 `.pi/skills/verify-paimeng-agent/`，当前目录缺失。其来源、版本、安装命令、功能地图和打包规则必须先按 Start and sequence 交付，不能把这个路径当作现成工具。开发实例 live 路径的现有入口是产品 [verify-paimeng](../../.claude/skills/verify-paimeng/SKILL.md)，同样须固定来源与分发文件；当前仅有首页创建 journey。实施时同步版本、排队、shell、实时预览、模板、部署及管理旅程。计划流程参考本机 `/home/zdan/.agents/skills/multi-phase-plan/references/workflow.md`，它不是仓库分发入口。

本次文档修订的检查命令（从仓库根）：

```bash
node "$(realpath /home/zdan/.agents/skills/multi-phase-plan/scripts/check-plan.mjs)" paimeng-ai-code-agent/docs/plans/app-runtime.md
```

使用 realpath 解析实际脚本入口，避免技能目录别名与脚本 main 判断不一致导致静默退出。本机解析结果是 `/home/zdan/github/astack/skills/multi-phase-plan/scripts/check-plan.mjs`。

2026-11-04 关闭 B1/B2 后本次实际运行的退出码为 0，输出为 `8 PR sections, 0 problems`。关闭前同一命令返回 1，诊断为 `plan is not Ready; resolve blockers before readiness checking` 和 `ready plan must declare Blockers. None.`；这两项只因当时的 Draft 状态与非空阻塞产生，解除后自然消失，没有改写 checker、没有隐去阻塞。

文档一致性检查确认八条原性能 Rule、八个 PR 及依赖顺序未变，42 个故事编号均有映射，PR 内未来任务全部未勾选，本地 Markdown 链接无断链。

文档检查只核对结构和约定一致性，不证明命令已能执行、运行场景充分或性能阈值合理。B1/B2 的关闭证据在 `runtime/evidence/app-runtime/preflight/`；本轮没有重跑 spike、启动产品或执行数据清理。
