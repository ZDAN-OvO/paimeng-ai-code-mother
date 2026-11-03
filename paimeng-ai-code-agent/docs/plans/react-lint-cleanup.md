# React 存量诊断清理 plan

目标：逐项处理 18 个文件中的 44 条 React lint 诊断，保持登录、积分、模型管理、版本、录音与聊天生成的可观察行为；新增保护迟到响应、重复提交和状态复用的检查。
范围：29 条 set-state-in-effect、10 条 exhaustive-deps、4 条 immutability、1 条 refs，以及对应组件、测试和抑制记录。
不做：升级 React/AI SDK、启用 React Compiler、引入全站状态库/请求框架、修改后端协议或数据库、重写整个聊天页。
判断：整体中等复杂；普通页面与弹窗较低，账单主从状态中等，聊天同步风险较高。44 是诊断数，不是 44 个已证实缺陷。
顺序：先完成 lint/Prettier 前置交付和最小可行性验证，再按普通页面 9 条 → 账单 13 条 → 交互会话 7 条 → 聊天 15 条串行交付。
本轮只调查与写计划，不修改产品实现，不提交、推送或创建 PR。

## How to read this

Status. Draft.
Blockers. G0：lint/Prettier 仍是未提交工作树，尚无可复现的前置合入提交；F1：下面列出的局部修法及跨边界 ref 识别尚无最小实验结果，不能保证既清零规则又保留时序。
Execution. 用户已明确启动。G0 已提交并推送（`1c41a93`，未合入），F1 已有观察结果；实施按 PR-01 → PR-04 串行、叠加在 `chore/lint-and-prettier` 之上，父项未合入前子项不进入 merge-ready。
Roles. 实施者负责产品与自检；每个 Behavior PR 由未参与该 PR 产品及检查实现的验证者执行 /verify-pr；用户审阅交互证据并独占合并权限。
Permissions. 本轮只有调查与规划授权，没有子 Agent、/spike、提交、推送、发布或合并授权。后续独立验证者可以是获授权的 Agent 或人工；没有独立验证则保持 pending。

一个勾选框对应一个有证据的交付动作；以下实施动作全部未完成。不能用改小范围、增加抑制或降低断言换取通过。

## Program checklist

### Start and sequence

G0 前置：将现有 lint/Prettier 工作单独做成可审查 PR，经验证后由用户决定合并。不是本计划新增的 PR 编号，不把当前 dirty 分支冒充 trunk。
F1 前置：按 Appendix A 的任务准备 /spike；只有获明确授权后才在隔离副本执行。观察完成后更新方案和验收，不在本轮顺手实现。
依赖图：G0 + F1 → PR-01 → PR-02 → PR-03 → PR-04。每个子 PR 从父 PR 合入后的实际 trunk 分叉；父项未合入，子项不进入 merge-ready。
每轮集成检查：`npm run check:fast && npm run type-check && npm test`，再执行该轮真实浏览器场景；最后全量 `npm run test:integration` 串行运行。

Parallel. None. 四组共同修改 `eslint-suppressions.json`、质量说明并共享 `_test` 数据库及 Redis DB 15；串行交付比为本次清理新增四套数据库更合理。后续若要并行，必须先指定唯一集成者处理共享文件，拆分数据库并重审本计划；单换端口不构成隔离。
Feasibility. F1 已在隔离 worktree 完成：原始诊断 44 条可复现；Ref 命名、纯 prepare 回调、带存活校验的 promise 回调、`afterOpenChange` + `initialValues` 表单会话、派生标记与按预览身份保存选中态五类修法，分别用原始 ESLint 扫描确认对应诊断消失（44 → 35，详见 Appendix A）。PR-01 已在叠加分支实现并跑真实浏览器证据；PR-02–04 仍须按各自 Verify 门禁验证。
Acceptance. A1–A6 的映射见下表；证据根为每个 PR 的 `runtime/evidence/react-lint/PR-NN/`，技能生成的浏览器证据包另保存原路径并在 handoff 中链接。
Changes. 改变目标、预算、覆盖、误报豁免或不适用理由须用户明确审查；保留原标准与变更原因。不能把存量转成 44 条行内 disable 宣称清零。

| 验收 | 所属 PR | 观察面与失败条件 | 证据目的地 |
| --- | --- | --- | --- |
| A1 原 44 条逐项结案 | 四组按 9/13/7/15 分担，PR-04 总结 | 普通 lint 和无 bulk suppressions 的原始 ESLint API 扫描；目标原始诊断为 0，抑制文件清空/删除，不新增关闭规则或绕过式延时。若证实唯一合理结果是豁免，保持 Draft 并交用户修改目标，不能擅自放宽 | 每组 `lint-raw.json`、`diagnostic-decisions.md` |
| A2 请求和用户作用域正确 | PR-01、PR-02 | 连续切账号/用户/筛选、关闭后重开，旧响应不能写回新页面/新用户；卸载后的响应不能发成功提示或改变当前状态 | `requests.json`、步骤截图、故障注入轨迹 |
| A3 表单会话和写幂等正确 | PR-02、PR-03 | 每次打开使用正确默认值/原值；同一次发放重试保持 requestId，相同已提交操作只落一份账本；重开才生成新会话 | `form-session.json`、只读 SQL 结果 |
| A4 录音/版本交互保持 | PR-03 | 自动停录只有一次，取消和卸载关音轨，不自动发送文本；版本重开、读取失败重试、切版聚焦正常 | `voice-events.json`、版本 API/截图 |
| A5 聊天时序保持 | PR-04 | 初始自动提交一次；流式过程中不因重渲染 stop；steer 早于回执不丢重；旧终态/历史不能覆盖新一轮；取消、提问、预览编辑选中清理正确 | `generation-order.json`、真实链路证据包 |
| A6 无明显额外请求和可见延迟 | 每组 | 相同浏览器驱动的基线/修改版本比较，阈值见各组 perf；不能用服务端处理时间替代 DOM 可见时间 | `perf-base.json`、`perf-head.json` |

### Evidence rules

Versions. 当前调查基线是 HEAD `13ef405b092afe704776ed8a4f0dd736457800ae` + 未提交 lint 工作树，tracked diff SHA-256 为 `3a1dce718288888fac053630d91bf8f57da10e9c8521e63f945047151edb4d5d`。本机调查清单（gitignored，不随仓库发布）为 `paimeng-ai-code-agent/runtime/plans/react-lint-cleanup/inventory.json`，保存诊断和文件哈希；它不是可替代合入提交的版本。逐文件行号已抄录在 Appendix A，仓库读者不依赖该本机文件。执行时记录 G0 合入 SHA、每个 PR 实际 base/head、dirty 状态、Node/依赖/夹具/数据库版本。
Invalidation. 产品、测试、规则、基线、依赖或环境变化后重跑受影响观察与独立验证；rebase 后重验集成。保留前一轮证据，不覆盖原始截图。旧基线缺陷必须如实记录；违反 A1–A6 仍阻断，不能用“原来就有”放行。
Input boundary. 主要结论用真实 UI → Next API → harness/preview，模型限 faux fixture；唯有竞态/错误恢复补充用例可延迟真实 HTTP 响应或模拟设备，并明确标成受控故障。既有 route.fulfill 用例只证明 UI 投影，不能替代真实持久化证据。

### Boot recipe

从仓库根执行 `bash .pi/skills/verify-paimeng-agent/doctor.sh`；任何 FAIL 先解决，历史迁移等 WARN 记入报告。命令入口见 [test-e2e.ts](../../scripts/verify/test-e2e.ts)，用 Node 24.15+，安装锁定依赖，不打印 .env。
从应用目录执行 `npm ci`，随后 `npm run check:fast && npm run type-check && npm test`。现有 `_test` 库、Redis DB 15 只串行占用；不能让集成测试与浏览器测试同时重置它们，更不能使用开发库跑重置测试。
每个工作树准备本机 `.env`，由隔离启动器强制映射到 `paimeng_app_test` / `paimeng_agent_test`。本机验证技能有绝对仓库定位：在其他 worktree 用它生成已支持的截图包前，先核对启动日志运行目录，不能以为它会自动跟随 cwd。
统一可复现启动命令从各树应用目录调用：`E2E_APP_MODE=dev E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated -- tests/e2e/platform.spec.ts --grep '浏览器完成注册|普通用户不能'`。启动器自选 harness 空闲端口，等待应用 `/api/health` 的 code=0 和 harness `/health` 的 ok=true，再启动 Playwright，负责 SIGTERM/SIGKILL 清理。
依次在 base/head 上使用相同模式、设备和输入；dev 用于 Hooks/antd 警告检查，另跑 production 构建回归，不混合比较开发冷编译与生产预热性能。
新验收 spec/采样 helper 由各 PR 拥有（见 Writes）；PR-01 的公共 helper 仅依赖现有 Playwright，读取请求计数和 DOM/事件时间，不能导入 head 产品内部状态。相同 driver 字节通过仅测试文件的 patch 安装到 base 的独立验证 worktree，再执行上述现有入口，记录 test-only patch 哈希、`playwright test --list`、原产品 base SHA。不得声称这是完全干净 base；driver 未创建/未实际启动前相应证据保持未验证。
需既有固定账号 proof 的场景可设置独立的 `E2E_PROOF_ACCOUNT=react_lint_<唯一后缀>` 和临时测试密码，只创建专属 `_test` 账号；不得修改 paimeng666 的密码。不需要真实付费模型。
只读诊断允许查看测试请求/响应、专属测试账号数据库行、console、页面错误、音轨和媒体事件。故障注入必须限定本次唯一账号/应用，不能修改生产共享状态。
完成后检查本次应用/预览/harness 监听和进程归属；只清理本次创建的进程组。保存截图、视频、网络与 SQL 产物；按本机技能生成 report/manifest，并执行 `bundle.mjs check`。

### Verdict and handoff

Review entity. 使用 GitHub `ZDAN-GHN/paimeng-ai-code-mother` 的真实 PR，正文按 /opening-a-pr；当前未创建。创建或发布需单独授权，URL 写入每组 handoff 后才可宣称 merge-ready。没有 forge 时只有用户明确接受绑定 base/head、diff、原始证据与审阅人的持久审阅记录才能替代。
Verdict. 每个 Behavior PR 的非作者验证者使用 /verify-pr 运行真实路径，检查修改过的测试、故障位置、误报论证和原始产物。未授权/未完成独立验证则 pending；验收未通过不能 PASS+NOTES。
所有 PR 都是交互行为变更，合并前用户须审阅 screenshots/video 并批准；发媒体不等于批准。CI、独立 PASS/PASS+NOTES、交互批准与显式合并授权缺一不可；按顺序合入后重新确认下一组实际基线。

## PR-01 整理普通页面与会话请求生命周期

**Depends on.** None.

**Files.**

Base. Trunk.
Writes. `src/components/providers.tsx`, `src/app/page.tsx`, `src/app/app/edit/[id]/page.tsx`, `src/components/admin-page.tsx`, `tests/e2e/react-page-lifecycle.spec.ts`, `tests/e2e/support/react-lifecycle-proof.ts`, `tests/e2e/platform.spec.ts`, `eslint-suppressions.json`, `docs/code-quality.md`。路径相对应用目录。
Resources. 独立 worktree/分支，专属唯一测试账号与应用；本轮独占 `_test` 库及 Redis DB 15，base/head 串行使用 3020/3021，harness 自选端口。无数据库迁移、lockfile 或依赖升级；质量说明与抑制文件只有本组写入。
Contract. 维持 useAuth 的 user/loading/refresh 接口、页面 URL 和现有 HTTP 信封；provider 是会话所有者，页面各自拥有查询数据。新增 helper 只供后续验收用例消费，不引入运行期共享请求框架。

- [ ] 只修改上述所有权内文件，逐项结案原清单中的 9 条诊断，更新抑制与说明；新验收文件的创建、导入和 Playwright 自动发现同 PR 完成。 Evidence. `runtime/evidence/react-lint/PR-01/scope.diff`。

**Build.**

- [ ] 把仅为同步 props 写入的派生数据改为当前用户/应用作用域内的状态；effect 中异步加载具有清理/代际校验，加载标记在正确的起点初始化。补齐稳定的 fetchApp/loadMy/loadGood/load 依赖；管理端不要因为 useCallback 依赖 query/pageSize 就在每次键入时隐式提交搜索。保持手动刷新和保存后的重新加载接口。拒绝为了避 lint 加 setTimeout/queueMicrotask 或只换 async 包装。 Evidence. `runtime/evidence/react-lint/PR-01/implementation.diff`。
- [ ] 创建本组声明的 react-* 验收 spec，读取公共 helper（PR-01 同时创建 helper）；补齐浏览器截图、视频配置、网络/DOM 采样、唯一账号清理与 JSON 产物，运行 `npx playwright test --list` 确认可加载。 Evidence. `runtime/evidence/react-lint/PR-01/driver-list.log`。

**You see.**

Kind. Behavior.
Surfaces. Web.
Interaction. Yes.

- [ ] 注册→登录→首页；注销/换账号不出现上个用户作品；应用编辑保存和刷新保持名称；管理员输入筛选后只有提交才查，分页/刷新仍正常。 Evidence. `runtime/evidence/react-lint/PR-01/journey.md`。

**Verify, unit.** Required.

Sensitivity. 在隔离副本移除代际/卸载保护，控制先发 A 查询最后返回，断言不能覆盖 B；另把管理端加载函数直接放进每次变化的依赖，检查输入但未提交时出现额外查询会失败。恢复后同样用例通过，禁止降低断言。

- [ ] 运行 `npm run check:fast && npm run type-check && npm test`，并用 ESLint Node API 对本组原路径输出未应用 bulk 的结果；逐项对应 Appendix A。 Pass when 命令退出 0，本组原始 React 诊断为 0，不新增行内 disable 或绕过式调度；敏感性副本中同一断言先拒绝故障，恢复后通过。 Evidence. `runtime/evidence/react-lint/PR-01/automated.log`。

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 在 G0/父项合入后的实际基线和本组 head 执行同一套用户输入、等待和断言：运行现有 platform.spec.ts 两条真实流程，再运行新增 react-page-lifecycle.spec.ts 的账号/应用切换和延迟响应场景；page.route 只对 route.fetch 得到的真实只读响应施加顺序控制，业务结果不伪造。 Pass when 所列用户路径、A1–A6 对应项与持久化断言满足；保存旧基线失败事实，不能降低目标。 Evidence. `runtime/evidence/react-lint/PR-01/base-head-live.md`。
- [ ] Surface. Web. 用 dev 构建核对 console、hydration、未处理 Promise 与 antd 表单绑定；截图覆盖初始、各动作与中间态、结果、刷新/重试，视频完整覆盖本组交互，不截断关键等待。 Pass when 无本组引入的运行时错误、状态不串作用域且刷新/重试符合契约；所有替代与受控故障均标注。 Evidence. `runtime/evidence/react-lint/PR-01/media-and-console.md`。

**Verify, perf.** Required.

- [ ] Metric. 一次稳定导航/搜索的业务查询数、响应到对应 DOM 可见的时长；真实写操作数量同时是正确性指标。 Evidence. `runtime/evidence/react-lint/PR-01/metric-definition.md`。
- [ ] Probe. 使用 PR-01 创建的 `tests/e2e/support/react-lifecycle-proof.ts` 和本组 react-* spec；同字节测试驱动按 Boot recipe 仅测试 patch 安装 base，走相同隔离启动命令；base→head→base→head，每版本 10 个预热后样本，Playwright 监听 request/response 与目标 DOM 可见时间，不用服务端耗时替代。 Evidence. `runtime/evidence/react-lint/PR-01/perf-raw.json`。
- [ ] Baseline. 先记录 G0/父项合入后的 base SHA 与测试 patch 哈希，再采样；本轮尚无测量值，不填估计值。 Evidence. `runtime/evidence/react-lint/PR-01/perf-base.json`。
- [ ] Rule. 同输入每种查询数不得超过 base；响应释放到页面目标内容 p95 ≤ base p95 + 100 ms，且绝对值 ≤ 15000 ms；10 次预热后样本按 base→head→base→head 交错采样，不含启动编译。所有阈值均须满足，100 ms 是相对额外可见延迟预算。 Limit. 100 ms. Evidence. `runtime/evidence/react-lint/PR-01/perf-verdict.json`。

**Review gate.** Required.

- [ ] 将已标注 base/head、真实链路及桩边界的 screenshots 和 video 交给 operator，取得交互 approval 后才可合并；仅上传媒体不算批准。 Evidence. `runtime/evidence/react-lint/PR-01/interaction-approval.md`。

**Merge.**

Verifier. Independent.

- [ ] 获授权后创建真实 PR，使用 /opening-a-pr 正文并记录 URL；非作者通过 /verify-pr 执行且审计原始证据，取得有效 PASS/PASS+NOTES，CI/代码审查/交互批准均通过。记录实际 base/head；停在 merge-ready，等用户明确合并授权。 Evidence. `runtime/evidence/react-lint/PR-01/handoff.md`。

## PR-02 按用户和弹窗会话整理积分页面状态

**Depends on.** PR-01.

**Files.**

Base. PR-01.
Writes. `src/components/billing/admin-usage-panel.tsx`, `src/components/billing/billing-history.tsx`, `src/components/billing/credit-balance.tsx`, `src/components/billing/credit-grant-dialog.tsx`, `src/components/billing/credit-operations-drawer.tsx`, `src/components/billing/credit-page.tsx`, `src/components/billing/credit-rule-dialog.tsx`, `src/components/billing/reconcile-panel.tsx`, `src/components/billing/user-search-select.tsx`, `tests/e2e/react-billing-lifecycle.spec.ts`, `tests/e2e/credit-ledger-verify.spec.ts`, `tests/e2e/billing-admin-overview.spec.ts`, `tests/e2e/billing-balance.spec.ts`, `eslint-suppressions.json`, `docs/code-quality.md`。路径相对应用目录。
Resources. 独立 worktree/分支，专属唯一测试账号与应用；本轮独占 `_test` 库及 Redis DB 15，base/head 串行使用 3020/3021，harness 自选端口。无数据库迁移、lockfile 或依赖升级；质量说明与抑制文件只有本组写入。
Contract. 保持现有积分 API、余额/流水投影与 requestId 幂等语义；CreditPage 拥有选中用户和详情作用域，弹窗拥有一次打开会话，父组件通知与 onDone 原签名不变。共享 UserSearchSelect 的所有调用者一并核对，不改变输入回车选择约定。

- [ ] 只修改上述所有权内文件，逐项结案原清单中的 13 条诊断，更新抑制与说明；新验收文件的创建、导入和 Playwright 自动发现同 PR 完成。 Evidence. `runtime/evidence/react-lint/PR-02/scope.diff`。

**Build.**

- [ ] 把有效选中用户由列表与显式选择推导，详情/账本按 userId 加代际并屏蔽旧数据；卸载、清空选择、切用户都使旧请求失效，loadMoreLedger 同样不能向新用户追加旧流水。用户选择搜索使用稳定回调，不能只用 query 字符串判断同文先后请求。加载态随请求会话管理。发放 requestId 从同次会话稳定保存；失败重试不换 ID，关窗重开才新建。规则/发放表单初始化放到真实打开会话，保留 antd 控件直连与当前限时/长期默认值。 Evidence. `runtime/evidence/react-lint/PR-02/implementation.diff`。
- [ ] 创建本组声明的 react-* 验收 spec，读取公共 helper（PR-01 同时创建 helper）；补齐浏览器截图、视频配置、网络/DOM 采样、唯一账号清理与 JSON 产物，运行 `npx playwright test --list` 确认可加载。 Evidence. `runtime/evidence/react-lint/PR-02/driver-list.log`。

**You see.**

Kind. Behavior.
Surfaces. Web.
Interaction. Yes.

- [ ] 切用户时身份与余额/流水一致；过滤、翻页、搜索回车和粘贴 ID 正常；发放失败后可重试且不重发积分，关窗重开恢复本次默认；改规则只影响未来，Owner 查账、冲正和补结算可刷新。 Evidence. `runtime/evidence/react-lint/PR-02/journey.md`。

**Verify, unit.** Required.

Sensitivity. 在隔离副本去掉详情/分页请求的 userId 或代际校验，旧 A 响应在 B 后到达必须被同一断言拒绝。写请求用 route.fetch 等待真实提交，再丢失首次响应，重试必须同 requestId 且 SQL 只新增一条；故障前置于提交不能证明幂等恢复。

- [ ] 运行 `npm run check:fast && npm run type-check && npm test && npx vitest run --project integration tests/integration/billing`，并用 ESLint Node API 对本组原路径输出未应用 bulk 的结果；逐项对应 Appendix A。 Pass when 命令退出 0，本组原始 React 诊断为 0，不新增行内 disable 或绕过式调度；敏感性副本中同一断言先拒绝故障，恢复后通过。 Evidence. `runtime/evidence/react-lint/PR-02/automated.log`。

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 在 G0/父项合入后的实际基线和本组 head 执行同一套用户输入、等待和断言：运行 credit-ledger-verify.spec.ts、billing-admin-overview.spec.ts、billing-balance.spec.ts，再运行新增 react-billing-lifecycle.spec.ts 的切用户/翻页迟到、表单重开、提交后丢响应重试场景；SQL 只读复核专属账号。既有账单种子是 SQL 夹具，不能证明真实模型结算。 Pass when 所列用户路径、A1–A6 对应项与持久化断言满足；保存旧基线失败事实，不能降低目标。 Evidence. `runtime/evidence/react-lint/PR-02/base-head-live.md`。
- [ ] Surface. Web. 用 dev 构建核对 console、hydration、未处理 Promise 与 antd 表单绑定；截图覆盖初始、各动作与中间态、结果、刷新/重试，视频完整覆盖本组交互，不截断关键等待。 Pass when 无本组引入的运行时错误、状态不串作用域且刷新/重试符合契约；所有替代与受控故障均标注。 Evidence. `runtime/evidence/react-lint/PR-02/media-and-console.md`。

**Verify, perf.** Required.

- [ ] Metric. 积分查询数、停止输入到搜索结果可见时长，以及真实发放业务条目数；真实写操作数量同时是正确性指标。 Evidence. `runtime/evidence/react-lint/PR-02/metric-definition.md`。
- [ ] Probe. 使用 PR-01 创建的 `tests/e2e/support/react-lifecycle-proof.ts` 和本组 react-* spec；同字节测试驱动按 Boot recipe 仅测试 patch 安装 base，走相同隔离启动命令；base→head→base→head，每版本 10 个预热后样本，Playwright 监听 request/response 与目标 DOM 可见时间，不用服务端耗时替代。 Evidence. `runtime/evidence/react-lint/PR-02/perf-raw.json`。
- [ ] Baseline. 先记录 G0/父项合入后的 base SHA 与测试 patch 哈希，再采样；本轮尚无测量值，不填估计值。 Evidence. `runtime/evidence/react-lint/PR-02/perf-base.json`。
- [ ] Rule. 250 ms 防抖保留，基线/head 同输入请求数不增加；停止输入到结果可见 p95 ≤ base p95 + 100 ms 且 ≤ 15000 ms；同 requestId 发放最多 1 条业务条目，额外条目预算为 0；每项采 10 次。所有阈值均须满足，100 ms 是相对额外可见延迟预算。 Limit. 100 ms. Evidence. `runtime/evidence/react-lint/PR-02/perf-verdict.json`。

**Review gate.** Required.

- [ ] 将已标注 base/head、真实链路及桩边界的 screenshots 和 video 交给 operator，取得交互 approval 后才可合并；仅上传媒体不算批准。 Evidence. `runtime/evidence/react-lint/PR-02/interaction-approval.md`。

**Merge.**

Verifier. Independent.

- [ ] 获授权后创建真实 PR，使用 /opening-a-pr 正文并记录 URL；非作者通过 /verify-pr 执行且审计原始证据，取得有效 PASS/PASS+NOTES，CI/代码审查/交互批准均通过。记录实际 base/head；停在 merge-ready，等用户明确合并授权。 Evidence. `runtime/evidence/react-lint/PR-02/handoff.md`。

## PR-03 按交互会话初始化模型版本和录音

**Depends on.** PR-02.

**Files.**

Base. PR-02.
Writes. `src/components/model-manager.tsx`, `src/components/chat/version-panel.tsx`, `src/components/chat/voice-input.tsx`, `tests/e2e/react-interaction-lifecycle.spec.ts`, `tests/e2e/model-manage.spec.ts`, `tests/e2e/version-panel.spec.ts`, `tests/e2e/chat-voice.spec.ts`, `eslint-suppressions.json`, `docs/code-quality.md`。路径相对应用目录。
Resources. 独立 worktree/分支，专属唯一测试账号与应用；本轮独占 `_test` 库及 Redis DB 15，base/head 串行使用 3020/3021，harness 自选端口。无数据库迁移、lockfile 或依赖升级；质量说明与抑制文件只有本组写入。
Contract. 模型编辑打开动作/表单保存、VersionPanel 的 open/onClose/onVersionApplied 和 VoiceInput 的 onTranscript 接口保持兼容；打开与关闭回调由各自父组件消费。不把录音设备对象或表单草稿提升为全局共享状态。

- [ ] 只修改上述所有权内文件，逐项结案原清单中的 7 条诊断，更新抑制与说明；新验收文件的创建、导入和 Playwright 自动发现同 PR 完成。 Evidence. `runtime/evidence/react-lint/PR-03/scope.diff`。

**Build.**

- [ ] 模型组件已有 openCreateProvider/openEditProvider/openAddModel 等事件先清理 probeText，删除重复 effect 前核对所有入口；保留当前配置回填、冲突后草稿和必要的表单挂载时机。版本加载按打开会话/appId 拥有 loading/diff 状态并防旧响应。录音能力检测保持服务端首屏与浏览器 hydration 一致；自动到时停止由录音会话的计时事件驱动，不能依赖未声明的渲染闭包；卸载/取消关闭轨道且只触发一次转写。 Evidence. `runtime/evidence/react-lint/PR-03/implementation.diff`。
- [ ] 创建本组声明的 react-* 验收 spec，读取公共 helper（PR-01 同时创建 helper）；补齐浏览器截图、视频配置、网络/DOM 采样、唯一账号清理与 JSON 产物，运行 `npx playwright test --list` 确认可加载。 Evidence. `runtime/evidence/react-lint/PR-03/driver-list.log`。

**You see.**

Kind. Behavior.
Surfaces. Web.
Interaction. Yes.

- [ ] 模型表单重开读当前值、取消不保存、版本冲突仍保留输入；版本抽屉重开/失败重试/切版后焦点正确；录音到时/取消/卸载只收尾一次、转写追加草稿并不自动发送。 Evidence. `runtime/evidence/react-lint/PR-03/journey.md`。

**Verify, unit.** Required.

Sensitivity. 隔离副本保留上一次表单 probe/diff 状态或去掉版本代际，重开/错序用例必须失败。将自动停录注册两次，设备适配计数应发现 stop/转写重复；去掉轨道清理则 active track 断言失败。设备模拟仅能证明应用事件流程。

- [ ] 运行 `npm run check:fast && npm run type-check && npm test`，并用 ESLint Node API 对本组原路径输出未应用 bulk 的结果；逐项对应 Appendix A。 Pass when 命令退出 0，本组原始 React 诊断为 0，不新增行内 disable 或绕过式调度；敏感性副本中同一断言先拒绝故障，恢复后通过。 Evidence. `runtime/evidence/react-lint/PR-03/automated.log`。

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 在 G0/父项合入后的实际基线和本组 head 执行同一套用户输入、等待和断言：运行 model-manage.spec.ts 的回填/冲突/保存真实本机上游场景和新增 react-interaction-lifecycle.spec.ts；version-panel.spec.ts/chat-voice.spec.ts 为补充接口桩 UI 测试。真实版本切换再运行 version-delivery-verify.spec.ts，用独立临时 proof 账号；录音至少取得真实浏览器媒体流再收尾的证据，模拟 MediaRecorder 不冒充物理麦克风证明。 Pass when 所列用户路径、A1–A6 对应项与持久化断言满足；保存旧基线失败事实，不能降低目标。 Evidence. `runtime/evidence/react-lint/PR-03/base-head-live.md`。
- [ ] Surface. Web. 用 dev 构建核对 console、hydration、未处理 Promise 与 antd 表单绑定；截图覆盖初始、各动作与中间态、结果、刷新/重试，视频完整覆盖本组交互，不截断关键等待。 Pass when 无本组引入的运行时错误、状态不串作用域且刷新/重试符合契约；所有替代与受控故障均标注。 Evidence. `runtime/evidence/react-lint/PR-03/media-and-console.md`。

**Verify, perf.** Required.

- [ ] Metric. 打开抽屉到表单可编辑/内容可见时长、一次录音会话的 stop 与转写请求数；真实写操作数量同时是正确性指标。 Evidence. `runtime/evidence/react-lint/PR-03/metric-definition.md`。
- [ ] Probe. 使用 PR-01 创建的 `tests/e2e/support/react-lifecycle-proof.ts` 和本组 react-* spec；同字节测试驱动按 Boot recipe 仅测试 patch 安装 base，走相同隔离启动命令；base→head→base→head，每版本 10 个预热后样本，Playwright 监听 request/response 与目标 DOM 可见时间，不用服务端耗时替代。 Evidence. `runtime/evidence/react-lint/PR-03/perf-raw.json`。
- [ ] Baseline. 先记录 G0/父项合入后的 base SHA 与测试 patch 哈希，再采样；本轮尚无测量值，不填估计值。 Evidence. `runtime/evidence/react-lint/PR-03/perf-base.json`。
- [ ] Rule. 可见时长 p95 ≤ base p95 + 100 ms 且 ≤ 15000 ms，10 次交错样本；stop 调用与转写请求每次至多 1；取消/卸载后 active tracks 为 0，转写不得自动触发生成，额外生成请求为 0。所有阈值均须满足，100 ms 是相对额外可见延迟预算。 Limit. 100 ms. Evidence. `runtime/evidence/react-lint/PR-03/perf-verdict.json`。

**Review gate.** Required.

- [ ] 将已标注 base/head、真实链路及桩边界的 screenshots 和 video 交给 operator，取得交互 approval 后才可合并；仅上传媒体不算批准。 Evidence. `runtime/evidence/react-lint/PR-03/interaction-approval.md`。

**Merge.**

Verifier. Independent.

- [ ] 获授权后创建真实 PR，使用 /opening-a-pr 正文并记录 URL；非作者通过 /verify-pr 执行且审计原始证据，取得有效 PASS/PASS+NOTES，CI/代码审查/交互批准均通过。记录实际 base/head；停在 merge-ready，等用户明确合并授权。 Evidence. `runtime/evidence/react-lint/PR-03/handoff.md`。

## PR-04 收拢聊天同步的 ref 所有权与终态转换

**Depends on.** PR-03.

**Files.**

Base. PR-03.
Writes. `src/app/app/chat/[id]/page.tsx`, `src/app/app/chat/[id]/use-generation-sync.ts`, `tests/e2e/react-chat-lifecycle.spec.ts`, `tests/e2e/chat-composer.spec.ts`, `tests/e2e/chat-initial-prompt.spec.ts`, `tests/e2e/chat-preview-rebuild.spec.ts`, `tests/e2e/generation-verify.spec.ts`, `eslint-suppressions.json`, `docs/code-quality.md`。路径相对应用目录。
Resources. 独立 worktree/分支，专属唯一测试账号与应用；本轮独占 `_test` 库及 Redis DB 15，base/head 串行使用 3020/3021，harness 自选端口。无数据库迁移、lockfile 或依赖升级；质量说明与抑制文件只有本组写入。
Contract. 保留消息/输入队列、Question、Steer、Follow-up、Generation 和进度事件契约；ref 归属只在 page 与 useGenerationSync 的内部 Interface 调整，所有调用者同时迁移。若验证命名识别足够，先最小改名；若确需命令式接口，必须小且隐藏共享可变写操作，不能新建一套并行状态机。

- [ ] 只修改上述所有权内文件，逐项结案原清单中的 15 条诊断，更新抑制与说明；新验收文件的创建、导入和 Playwright 自动发现同 PR 完成。 Evidence. `runtime/evidence/react-lint/PR-04/scope.diff`。

**Build.**

- [ ] 把 activeGenerationId/shownMessageIds/settledGenerations 的写所有者与读取者明确化，识别 Ref 后补齐真实稳定依赖；transport 发送时仍读取最新 question/requestId，不在 render 执行回调。effect 初始化依赖不能因每次输入/运行态更新重建并 stop 活动流。记忆/修复标记、busy 秒数、选中元素按生成或预览身份推导/事件重置，清除旧状态而不引入渲染循环。首次初始提示发送保留历史/任务就绪判定和一次性约束；迟到终态必须核对当前生成。 Evidence. `runtime/evidence/react-lint/PR-04/implementation.diff`。
- [ ] 创建本组声明的 react-* 验收 spec，读取公共 helper（PR-01 同时创建 helper）；补齐浏览器截图、视频配置、网络/DOM 采样、唯一账号清理与 JSON 产物，运行 `npx playwright test --list` 确认可加载。 Evidence. `runtime/evidence/react-lint/PR-04/driver-list.log`。

**You see.**

Kind. Behavior.
Surfaces. Web.
Interaction. Yes.

- [ ] 新应用只自动发送一次，刷新不重复；生成时重渲染不重置页面或中断流；回执与 steer/终态乱序仍无重复气泡；旧轮结果不盖新轮；提问回答、取消、丢失输入重发和预览编辑退出清理保持。 Evidence. `runtime/evidence/react-lint/PR-04/journey.md`。

**Verify, unit.** Required.

Sensitivity. 同一用例故障副本去掉 terminal 的 active-generation 核对，先发旧轮最后返回，应出现错误覆盖并被拒绝；移除一次性自动提交保护，断言请求数/Generation 行数必须发现重复；令同步回调每次渲染换身份，断言活动流不能出现多余 cancel/stop；每项恢复后重验。

- [ ] 运行 `npm run check:fast && npm run type-check && npm test && npm run test:integration`，并用 ESLint Node API 对本组原路径输出未应用 bulk 的结果；逐项对应 Appendix A。 Pass when 命令退出 0，本组原始 React 诊断为 0，不新增行内 disable 或绕过式调度；敏感性副本中同一断言先拒绝故障，恢复后通过。 Evidence. `runtime/evidence/react-lint/PR-04/automated.log`。

**Verify, live.** Required.

- [ ] Regression against trunk. Surface. Web. 在 G0/父项合入后的实际基线和本组 head 执行同一套用户输入、等待和断言：先运行 chat-composer.spec.ts、chat-initial-prompt.spec.ts、chat-preview-rebuild.spec.ts 的接口桩竞态；再运行 generation-verify.spec.ts、ask-question-verify.spec.ts 和新增 react-chat-lifecycle.spec.ts 的真实 UI→Next→harness→preview 场景，保留唯一账号/应用/Generation 的请求时间线及 SQL 回读。接口桩通过不能替代真实 Follow-up/Question 和刷新证据。 Pass when 所列用户路径、A1–A6 对应项与持久化断言满足；保存旧基线失败事实，不能降低目标。 Evidence. `runtime/evidence/react-lint/PR-04/base-head-live.md`。
- [ ] Surface. Web. 用 dev 构建核对 console、hydration、未处理 Promise 与 antd 表单绑定；截图覆盖初始、各动作与中间态、结果、刷新/重试，视频完整覆盖本组交互，不截断关键等待。 Pass when 无本组引入的运行时错误、状态不串作用域且刷新/重试符合契约；所有替代与受控故障均标注。 Evidence. `runtime/evidence/react-lint/PR-04/media-and-console.md`。

**Verify, perf.** Required.

- [ ] Metric. 生成请求数、活动流额外 stop/cancel 次数、终态收到到 DOM 收尾时长和 30 秒内运行态轮询数；真实写操作数量同时是正确性指标。 Evidence. `runtime/evidence/react-lint/PR-04/metric-definition.md`。
- [ ] Probe. 使用 PR-01 创建的 `tests/e2e/support/react-lifecycle-proof.ts` 和本组 react-* spec；同字节测试驱动按 Boot recipe 仅测试 patch 安装 base，走相同隔离启动命令；base→head→base→head，每版本 10 个预热后样本，Playwright 监听 request/response 与目标 DOM 可见时间，不用服务端耗时替代。 Evidence. `runtime/evidence/react-lint/PR-04/perf-raw.json`。
- [ ] Baseline. 先记录 G0/父项合入后的 base SHA 与测试 patch 哈希，再采样；本轮尚无测量值，不填估计值。 Evidence. `runtime/evidence/react-lint/PR-04/perf-base.json`。
- [ ] Rule. 首次进入最多 1 次自动生成；用户没取消时额外 stop/cancel 为 0；终态 DOM p95 ≤ base p95 + 100 ms 且 ≤ 2000 ms；30 秒窗口同输入轮询数不超过 base+1；10 次交错样本，不测真实模型 token 速度。所有阈值均须满足，100 ms 是相对额外可见延迟预算。 Limit. 100 ms. Evidence. `runtime/evidence/react-lint/PR-04/perf-verdict.json`。

**Review gate.** Required.

- [ ] 将已标注 base/head、真实链路及桩边界的 screenshots 和 video 交给 operator，取得交互 approval 后才可合并；仅上传媒体不算批准。 Evidence. `runtime/evidence/react-lint/PR-04/interaction-approval.md`。

**Merge.**

Verifier. Independent.

- [ ] 获授权后创建真实 PR，使用 /opening-a-pr 正文并记录 URL；非作者通过 /verify-pr 执行且审计原始证据，取得有效 PASS/PASS+NOTES，CI/代码审查/交互批准均通过。记录实际 base/head；停在 merge-ready，等用户明确合并授权。 Evidence. `runtime/evidence/react-lint/PR-04/handoff.md`。

## Close the program

只有用户明确启动实施并且 G0/F1 解除后才执行以上清单。最终交付 44 条逐项处理记录、原始 lint 0 条与空/删除抑制文件、四个真实 PR 链接、独立验证结论、步骤截图/视频、故障敏感性证明和性能实测。
本计划当前不包含这些实施产物；实际结项需要 A1–A6 全满足。任何无法安全清理的诊断都单列事实和替代方案，等待用户审查验收变更，不得以工具通过代替行为证明。

## Appendix A. Spike evidence

### 已核对的事实与限制

1. 原始扫描：从应用目录运行 ESLint Node API `new ESLint().lintFiles(['src'])`，读取各文件 `messages`，不经过 CLI 的 bulk suppression；实际复现 44 条、18 个文件。调查清单包含原始诊断和哈希。普通 `npm run lint` 的通过不证明这些诊断消失。
2. SDK 回调时机：AI SDK `7.0.130` 的 [DefaultChatTransport](../../node_modules/ai/src/ui/default-chat-transport.ts) 构造只调用 super；[HttpChatTransport](../../node_modules/ai/src/ui/http-chat-transport.ts) 构造只赋值 `prepareSendMessagesRequest`，`sendMessages` 才调用它。由此确认现有 callback 内 ref 访问不等于构造时执行；尚未证明哪种局部重构能让插件也正确理解它。
3. ref 识别：本机 eslint-plugin-react-hooks 的 `RefLikeNameRE` 明确识别 `ref` 与以 `Ref` 结尾的名称；诊断也提示 activeGenerationId 可改成 Ref 后缀。原始类型本身确为 React RefObject。证据只支持优先验证识别/命名问题，不支持直接认定全部四条为真实不可变性错误或认为改名必定足够。
4. 外部数据加载：providers.refresh、Home.loadGood/loadMy、AppEdit.fetchApp 和 CreditPage.loadStats 存在 await 后再写 React 状态的正常路径，其中一些仍被插件报告。需要区分同步 loading/reset、catch/finally、派生状态和真正异步结果，而不是机械删除所有 effect。没有测得 29 条都造成额外渲染或死循环。
5. 已有事件可承载初始化：model-manager 的 openCreateProvider/openEditProvider/openAddModel 已清 probeText，后续 effect 再清是可调查的重复来源；仍须验证表单未挂载时 setFieldsValue 及重开/冲突草稿，不能只删除 effect 就宣称行为等价。
6. 危险共享：聊天 page 初始化写 shownMessageIds，useGenerationSync 也写它；activeGenerationId 由 page 传入并被 Hook 改写；setMessages 更新函数里还写 ref。回执、终态、运行态和刷新多来源交错，已有多条竞态用例，但大量用 page.route 构造响应，必须另补真实链路观察。
7. 既有运行证据：前一轮 lint 接入的本机验证报告（`.pi/skills/verify-paimeng-agent/evidences/26-11-03/platform-180016/report.md`，.pi 已 gitignore，不随仓库发布）记录 13ef405 dirty 上的真实平台两条流程、生产构建和 9 张截图；512 单元、475 集成通过的日志也存在本机 `/tmp/pi-processes-ABFd2S/`。这些仅说明当时部分行为可用，不能代替本计划新增时序/性能场景，也不能给未来 head 发通过结论。

### F1 最小可行性实验结果

在独立 worktree（`runtime/react-lint-spike`，分支 `spike/react-lint`，基线 `d8c00e3`）按同一份原始 ESLint Node API 扫描（不应用 bulk suppressions）观察到：

| 修法 | 观察对象 | 结果 |
| --- | --- | --- |
| Ref 统一以 `Ref` 结尾（不改语义） | chat page + useGenerationSync | 该目录 15 → 11；4 条 immutability 消失，属插件按命名识别 Ref 的误报 |
| transport 的 prepare 回调改为纯函数，requestId 在发送事件里生成 | chat page | 1 条 refs 消失；原有“渲染时读 ref”实际只在发送时执行，改成事件生成后连插件也不再报 |
| effect 内改用带存活校验的 promise 回调写状态 | credit-balance | 1 → 0；同时补上了原实现缺失的卸载/切换用户保护 |
| 删除打开弹窗的 effect，改用 `afterOpenChange` 重置 requestId + `initialValues` | credit-grant-dialog | 1 → 0 |
| 派生 `generating && memoryBusy`、按预览身份保存选中态 | chat page | 2 条 set-state 消失；不再需要“生成结束/预览变化”时同步清空 |

应用上述切片后，扫描集合从 44 条降到 35 条，剩余为 2 条真实待重构（refresh 用量、初始提示自动发送）和 6 条依赖数组问题（其中 2 条是切片未完成的临时产物）。该 worktree 是部分切片，不作为可合入提交；PR-01 另在 `agent/react-lint-pages` 上按同一批模式实现，类型、lint、单测与浏览器证据见对应 PR。

实验产物在本机 `paimeng-ai-code-agent/runtime/plans/react-lint-cleanup/spike/`（gitignored）：`raw-lint-before.txt`、`raw-lint-after.txt`、`pattern-changes.diff`。这组观察只证明“这些写法能让规则与类型同时成立”，不证明每个组件的行为等价；行为由每个 PR 的 Verify 门禁单独证明。

SDK 源码哈希：default-chat-transport `60efc63699c7f97abb7c00f5d62ae04de45310ee4086a32cafecc4d9505139ac`；http-chat-transport `e450c8d367f41703d90a4dd7fd785903d98d80bfbc6b18381e01d62dc6483425`。react-hooks 插件 JS 哈希 `d401e94560ab2660e40fe59a3408828b96d78e9929a22358386aa51acbe32e2b`。重装或更新后重新核对。

### F1 最小可行性任务（准备交给 /spike，尚未获授权执行）

问题：不关闭规则、不单纯延后 setter、也不改变业务时序，能否用局部变更处理 ref 推断、异步加载与表单打开会话？
备选：保持 ref 实体但统一 Ref 命名；将跨边界写入封装为少数稳定命令；transport 的 prepare 回调单独稳定构造；表单使用真实打开事件/按会话挂载。不要一次引入 store、SWR、React Query 或新后端协议。
范围：独立可丢弃 worktree，基于 G0 固定版本；只改聊天 page/Hook、一个纯异步加载页面、一个发放弹窗和一个模型表单的最小切片，禁止触碰共享 .env/开发数据。保存原/改后源码、哈希、raw ESLint JSON、类型结果和浏览器轨迹。
观察一：对 Ref 命名与 prepare callback 的最小切片重跑 raw ESLint，比较 diagnostics，不接受规则 off、bulk/inline disable 或无理由 setTimeout/Promise 包装。
观察二：同一请求强制 A 先发晚回/B 后发早回；画面最终是 B、A 不能覆盖。录制真实浏览器导航、输入和响应释放顺序，不以 Node 计时器代替界面结果。
观察三：真实 antd 弹窗连续打开/取消/重开，默认值和当前用户正确，同一次提交后失响应重试仍用同 requestId；只允许 `_test` 的唯一账号，副作用通过 SQL 查账。
观察四：聊天首次初始化/刷新/生成中输入重渲染、旧终态晚回，不能触发额外 start/stop 或覆盖新一轮。现有桩场景能证 UI 时序，另用 fixture harness 确认真实提交和预览。
通过条件：上述切片 lint 消失且行为、类型通过；driver 能在实际 base/head 启动；据实际结果固定四组修法。失败或不确定时保留 Draft，写清哪条假设被否定，不追加豁免偷过。
产物位置：`runtime/plans/react-lint-cleanup/spike/`，包含 `source/`、`decision.md`、raw lint、请求/SQL、视频和截图；本轮不存在这些实验产物。准备工作有边界但不授予 /spike 执行权限。

### 逐文件诊断与建议归属

下表为本次原始扫描行号；排版和后续修复会移动行号，以调查清单里的文件哈希绑定。

| 文件 | 条数与原位置 | 所属 PR | 重点 |
| --- | --- | --- | --- |
| [app/app/chat/[id]/page.tsx](<../../src/app/app/chat/[id]/page.tsx>) | 13：refs:461；set-state-in-effect:691；set-state-in-effect:696；set-state-in-effect:703；immutability:710；immutability:736；exhaustive-deps:753；set-state-in-effect:824；set-state-in-effect:829；exhaustive-deps:991；exhaustive-deps:1063；exhaustive-deps:1093；set-state-in-effect:1100 | PR-04 | transport/ref、初始发送、派生标记、预览编辑清理 |
| [app/app/chat/[id]/use-generation-sync.ts](<../../src/app/app/chat/[id]/use-generation-sync.ts>) | 2：immutability:139；immutability:145 | PR-04 | 共享 Ref 的识别与写所有权；同一写位置报告两条 |
| [app/app/edit/[id]/page.tsx](<../../src/app/app/edit/[id]/page.tsx>) | 2：set-state-in-effect:55；exhaustive-deps:56 | PR-01 | id 变化与保存回读的作用域 |
| [app/page.tsx](<../../src/app/page.tsx>) | 4：set-state-in-effect:62；exhaustive-deps:63；set-state-in-effect:65；exhaustive-deps:67 | PR-01 | 稳定加载回调；用户作用域和清空；防止输入就触发查询 |
| [components/admin-page.tsx](<../../src/components/admin-page.tsx>) | 2：set-state-in-effect:93；exhaustive-deps:94 | PR-01 | 搜索提交与分页依赖，不引入自动提交 |
| [components/billing/admin-usage-panel.tsx](<../../src/components/billing/admin-usage-panel.tsx>) | 1：set-state-in-effect:60 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/billing-history.tsx](<../../src/components/billing/billing-history.tsx>) | 1：set-state-in-effect:69 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/credit-balance.tsx](<../../src/components/billing/credit-balance.tsx>) | 1：set-state-in-effect:30 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/credit-grant-dialog.tsx](<../../src/components/billing/credit-grant-dialog.tsx>) | 1：set-state-in-effect:42 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/credit-operations-drawer.tsx](<../../src/components/billing/credit-operations-drawer.tsx>) | 1：set-state-in-effect:44 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/credit-page.tsx](<../../src/components/billing/credit-page.tsx>) | 4：set-state-in-effect:112；set-state-in-effect:123；set-state-in-effect:128；set-state-in-effect:131 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/credit-rule-dialog.tsx](<../../src/components/billing/credit-rule-dialog.tsx>) | 1：set-state-in-effect:140 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/reconcile-panel.tsx](<../../src/components/billing/reconcile-panel.tsx>) | 1：set-state-in-effect:51 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/billing/user-search-select.tsx](<../../src/components/billing/user-search-select.tsx>) | 2：set-state-in-effect:61；exhaustive-deps:62 | PR-02 | 用户/查询/弹窗会话与迟到响应 |
| [components/chat/version-panel.tsx](<../../src/components/chat/version-panel.tsx>) | 1：set-state-in-effect:218 | PR-03 | 打开与读取/差异状态会话 |
| [components/chat/voice-input.tsx](<../../src/components/chat/voice-input.tsx>) | 3：set-state-in-effect:127；set-state-in-effect:234；exhaustive-deps:236 | PR-03 | 能力探测、自动停录、闭包与清理 |
| [components/model-manager.tsx](<../../src/components/model-manager.tsx>) | 3：set-state-in-effect:186；set-state-in-effect:191；set-state-in-effect:202 | PR-03 | 初始化重复与表单会话 |
| [components/providers.tsx](<../../src/components/providers.tsx>) | 1：set-state-in-effect:31 | PR-01 | 会话异步加载，不将 await 后的 setter 一概当同步错误 |

## Appendix B. Alternatives rejected

- 不做“一把 --fix”：依赖会改变何时发请求/终止流，ref 的四条也可能是推断问题，自动修复不能决定业务时序。
- 不用微任务/零延时定时器隐藏 setter：这会改变执行顺序，规则消失不等于多余状态被移除。
- 不把 44 条平移成行内 disable：丢失原有存量约束，也不满足 A1。若某条确实是工具边界，需单独提出事实与标准变更。
- 不引入全站请求库或大状态机：未证实现有局部 effect 无法表达需求；本任务的收益不足以支撑全站迁移。
- 不一次大 PR：聊天和积分幂等的失败模式不同，统一改动会使回归定位与独立验证困难。四组保持现有 API，每组都可独立部署。

## Appendix C. Risks

| 风险 | 所属 | 限制与观察失败条件 |
| --- | --- | --- |
| 把工具误报当产品缺陷 | F1/PR-04 | 对照 SDK 和插件实际源码，实验记录 raw lint；不能只改到规则看不见 |
| 回调稳定性改变导致重复请求/stop | PR-01/PR-04 | 查询计数与真实 Generation 请求/终止时间线，任何额外自动写入/取消失败 |
| 快速切用户旧余额/流水串到新人 | PR-02 | 真实 GET 延迟/错序、分页跨切换，画面身份与数据不符失败 |
| 幂等 ID 被每次 render/retry 重建 | PR-02 | 提交后丢响应，SQL 业务条目多于 1 或两次 requestId 不同失败 |
| 表单初始化早于挂载、回填丢失 | PR-02/PR-03 | dev 模式、连续打开、冲突保留草稿；表单看着正常但保存值错误也失败 |
| hydration 或录音资源泄漏 | PR-03 | 服务端首屏一致、卸载轨道数归零、只 stop/转写一次；模拟设备边界如实标注 |
| 验证套件接口桩过多 | PR-03/PR-04 | UI 桩仅作补充，真实模型 fixture 路径及测试库 SQL 必须另跑 |
| 共享数据库或 worktree 混用 | 全部 | 串行、真实工作目录/端口/数据库记录，不能因工作树不同就并行重置测试库 |
| 改到用户 app-runtime 工作 | 全部 | 仅按 Writes 实施；保留现有未提交 app-runtime 文档/原型，不能 git reset/clean |

无需 schema/data migration，回滚每个产品 PR 后重跑该组行为；不能回滚数据库已写的测试/业务记录来冒充代码回滚。实际线上发布不在本轮授权范围。

## Appendix D. Links and decisions

- [产品目录约定](../../AGENTS.md)、[测试资源约定](../../tests/AGENTS.md)、[脚本入口约定](../../scripts/AGENTS.md)、[文档生命周期](../AGENTS.md)。
- [ESLint 配置](../../eslint.config.mjs)、[存量抑制](../../eslint-suppressions.json)、[质量说明](../code-quality.md)、[验证入口](../../scripts/verify/test-e2e.ts)、[浏览器配置](../../playwright.config.ts)。
- [React effect 指南](https://react.dev/learn/you-might-not-need-an-effect)、[同步外部系统与 cleanup](https://react.dev/learn/synchronizing-with-effects)、[Refs 规则](https://react.dev/reference/eslint-plugin-react-hooks/lints/refs)。源码和本地实测优先于只看通用文档推断。
- 最初平台验证报告位于本机 `.pi/skills/verify-paimeng-agent/evidences/26-11-03/platform-180016/report.md`（不随仓库发布），只绑定旧 dirty 状态，不能给未来实施背书。
- 计划入口为本文件；调查产物保存在 runtime，未来 PR 的 /opening-a-pr /verify-pr 记录绑定各自 base/head。用户未授权本轮实施、提交或合并。
- 实际计划检查命令：`node /home/zdan/github/astack/skills/multi-phase-plan/scripts/check-plan.mjs paimeng-ai-code-agent/docs/plans/react-lint-cleanup.md`。`.agents/skills/multi-phase-plan` 是符号链接，当前 checker 的 main 判断比较入口路径与真实路径，直接调用链接入口会空跑；因此使用已核对的 realpath 执行。未修改技能脚本。
- 实际检查结果：退出码 1，`4 PR sections, 2 problems`，两项分别为 Draft 非 Ready、Blockers 非 None。完整输出在 `paimeng-ai-code-agent/runtime/plans/react-lint-cleanup/plan-check.log`（本机，gitignored）。结构字段未另报问题，但这不证明语义、可行性或未来实施正确；保留阻塞而不改状态求通过。
