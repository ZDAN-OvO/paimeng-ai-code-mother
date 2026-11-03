# 积分计费的运行说明

积分的账务运维包括**每月限时积分**（规则发放、补发、过期、查账）与**补结算/余额对账**（漏账补记、待处理重试、快照核对）；两者都没有常驻定时器，触发点在请求路径、Admin 入口或外部 cron 调的 CLI 上。模型售价在 `/admin/models` 管理，不再有独立 Rate card 维护入口。

## 模型单价与历史快照

当前定价见 [ADR-0006](adr/0006-model-config-document.md)，它替代 [ADR-0004](adr/0004-credit-billing.md) 的 Rate card/3 倍 Markup 售价来源，保留 Credit 面额与其它结算规则。

- 提供商、嵌套模型、价格版本和槽位分配在 `app_config.value` 的一份 JSONB 文档内（`key='model_config'`）。Admin 在模型下明确填写未命中输入、缓存命中输入、输出三档元 / 1M tokens；服务端存非负整数分 / 1M tokens，三档不能全为 0。
- **1 Credit = ¥0.01 = 1 分**。例如输入价 ¥6 / 1M tokens 存为 600，100,000 个未命中输入 token 对应 60 Credit。不同 token 类别先按分价相乘累计，只在总额层四舍五入一次，不逐步取整。reasoning 已含在 output 中，不另收一次；非 token 动作不新增收费。
- 可选的上游 USD 价格仅用于参考/成本记录；未知保持未知，不从售价反算成本。售价不通过倍率或汇率计算。模型级 `upstreamPrice` 是当前参考信息；价格版本的 `upstreamUsd` 是该版本供计费使用的可选成本数据，两者不应混同。
- 管理流程是「配置提供商 → 登记模型与能力 → 明确填价 → 分配槽位」，详见[模型配置](provider-convergence.md#admin-配置流程与人民币单价)。改价保存只追加 `prices[]` 的 `version` 和服务端 UTC `effectiveAt`，不能通过当前 Admin 表单回填过去或预约未来。迁移保留的未来版本可读，到时才生效。
- Billing 在结算事务中从 JSON 展开价格视图，按步骤发生时间选不晚于该时刻的最新价格；未来价不提前应用。配置 `revision` 表示整份文档的编辑版本，不是某一笔账单采用的价格版本，也不能代替账单快照。
- `credit_charge.usage_snapshot` 保存步骤用量与采用的版本键，`rate_card_snapshot` 保存实际采用的价格值；版本键沿用提供商 ID、模型名、`effectiveFrom` 的兼容形状。文档内的价格序号不会替换旧快照结构。**已计价步骤的用量和适用价格不可因当前配置变化而重写**；补结算只追加未计价/晚到步骤的事实并更新账单投影，冲正用补偿分录。历史金额、成本和已采用价格不能从当前 JSON 重新推算。

### 缺价处理

先查清步骤的提供商、请求/响应模型名、UTC 时间及已有快照，再决定处理范围。新分配要求当前有效单价；初始化或旧数据仍可能缺价。当前追加一个「现在生效」的价格不会给过去的步骤补价。修改旧 `credit_rate_card` 也不会被新运行时读取。

旧 `unpriced`/`partial` 需要覆盖当时发生时间的价格版本：走经过审查的迁移/修复流程，保留原价历史、确认模型归属、在行锁与 revision 校验下写入文档，再 dry-run 补结算核对待扣范围。当前 Admin 没有历史补价入口，不能把「保存新价 → 重试」承诺为通用修复。缺估算样本则需先核对用量来源，补价格不能生成样本。任何修复均不得覆盖已采用的账单快照。

## 模型配置迁移与回退

结构入口是 [023_app_config_model_config.sql](../migrations/023_app_config_model_config.sql)，只建承载表和空文档，不自动搬迁或补扣。旧 `model_provider`、`model_alias`、`model_config_state`、`credit_rate_card` 保留一个发布周期作为回滚依据；切换后运行期不再读写这些表，没有双写。

本分支的迁移必须等待 `scripts/db/backfill-model-config.ts` 与 `db:backfill-model-config` npm 入口集成、评审和演练通过。以下是工具集成后的操作顺序，不是本次文档变更已经执行的迁移记录：

1. 备份产品库并记录应用版本、迁移版本、旧模型配置版本、活动生成、待补账单数量，以及 `credit_charge` 的金额/用量/价格快照和 `credit_entry` 对照基线。包含 inline 密文的完整配置备份按密钥材料保护，不打印到报告；同时保留可用的模型主密钥。
2. 暂停管理端模型配置写入和新生成提交，等待活动生成结束，暂停可能写账的补结算入口以稳定对照基线。用 `npm run db:migrate` 应用新结构，再运行默认只读预检：
   ```bash
   cd paimeng-ai-code-agent
   npm run db:backfill-model-config
   ```
   预检必须列出提供商/模型/槽位归并、能力冲突、精确匹配价格、孤立历史价格和目标文档状态；有未裁决冲突就停止。不要在旧库上运行 `db:init-models` 代替回填，也不要把空载体文档当作没有旧配置。
3. 审查预检，确认旧 Credit / 1M 数值按 **1 Credit = 1 分** 原样写成 CNY 分价（不乘 100、不引入汇率/倍率），所有原有效时间包括未来时间保留。不能精确关联当前模型的价格保留在 `legacyPrices`，不伪造当前模型或用当前槽位解释历史步骤。确认后执行：
   ```bash
   npm run db:backfill-model-config -- --apply
   ```
   回填应在事务/版本保护下完成且重复执行不重复创建；不得修改历史账单、分录或触发结算。对照基线证明这些事实未变，再继续切换。
4. Next 与 harness 使用同一 JSON 配置版本发布；管理端刷新核对 DB revision、必需槽位、模型能力与当前价格，验证新绑定的提供商、模型和实际采用价格。只看迁移成功或模型列表不够，已有旧会话恢复也须验证。全新空库才走 `npm run db:init-models`，随后明确补价；它不会自动复制旧预置价格。
5. `npm run billing:reconcile` 只读检查待处理范围，确认没有迁移引起的意外待扣变化；重新开放配置与生成，再按本 runbook 独立执行获准的补结算。结构回填不构成历史补扣授权。

回填失败先回滚该事务，保留预检报告，重新核对版本再重试。切换前旧程序仍以旧表为准；切换后旧表不跟随 JSON 修改，保留表本身不保证可直接回退。若还没有新配置或账务写入，可在确认旧配置与备份一致后成套回退 Next/harness；一旦有新 JSON 配置、价格或账务事实，暂停新提交，优先修复前进。确需回退时先核对并保全新增配置、账单和分录，不能恢复旧备份丢掉已发生的扣款/发放，也不能用旧代码重新解释新账单。删除旧表须另做迁移并确认一个发布周期的回滚窗口已结束。

## 每月限时积分

模型见 [ADR-0006](adr/0006-single-credit-ledger.md)：积分只有一张追加式账本 `credit_ledger`，
「限时 / 长期」是同一个可用额按 `expires_at` 切开的两段，不是两个池。代码在
`src/server/billing/quota.ts`、`expiry.ts`、`quota-policy.ts` 与 `operations.ts`。

### 账期口径

- 账期是**北京时间自然月**（UTC+8，没有夏令时），字符串形如 `2026-11`。北京时间每月 1 号 00:00 之后属于新账期，见 `src/server/billing/period.ts`。
- 每月标准由策略决定：全局默认 + 单用户覆盖。没有保存过全局策略时用 500 积分兜底（`monthlyQuotaCredits`，`src/shared/billing.ts`）。覆盖可以是 0；`inherit` 表示清除覆盖、回到全局默认，两者不是同一种事实。
- 每人每账期一条 `kind='quota'`、`origin='rule'` 的账本行；**金额 0 也写**（`credits=0`），所以「待发」= 本期没有规则行，不看余额、不看金额。用户侧账单隐藏 0 行，管理员流水保留并置灰。
- 策略只能从**未来账期**生效；当月要改某个人，用「发放限时积分」追加一条 `origin='manual'` 条目，不改已发月份。
- 限时积分**不累积、不结转、不折现**：账期结束时剩余部分写成一条 `kind='expire'` 的负行（`origin='expiry'`），金额 = 发放 − 消费净额 − 已过期。
- 幂等由部分唯一索引保证：`(user_id, period) where kind='quota' and origin='rule'`。

### 什么时候会发

发放是**懒触发**的，仓库里没有常驻定时器：

| 触发点 | 位置 | 说明 |
| --- | --- | --- |
| 注册 | `src/server/auth/auth.ts` 的 `register()` | 注册成功即发当月规则；发放失败只记日志，不影响注册 |
| 读额度摘要 | `GET /api/billing/summary` | 返回前先确保当期规则，所以停机错过月初的用户打开页面就补上 |
| 补发待发 | `npm run billing:quota-issue` 或 Admin「补发待发」 | 见下节 |

三者都调用 `ensurePeriodQuota`，并发或重跑都不会多发。

### 补发

前提：产品库已经迁移到最新（`npm run db:migrate`），`credit_ledger` / `credit_balance` 存在。

```bash
cd paimeng-ai-code-agent
npm run billing:quota-issue                 # 试运行：只报「待发放用户数」，不写库
npm run billing:quota-issue -- --apply      # 真正发放
npm run billing:quota-issue -- --apply --limit=200
```

- 默认试运行，`--apply` 才写库；脚本自己校验目标库只能是 `paimeng_app` 或 `paimeng_app_test`。
- 一次最多处理 1000 个用户（`--limit` 可改），剩下的下一次继续——幂等所以不需要记录进度。「待发放用户」= 本期没有规则行且未删除的用户。0 积分用户也会被记为已处理，不会每次都被重复扫描。
- 输出给出「新建规则行 / 正数积分 / 0 积分 / 合计积分」与 `operationId`；Admin「最近操作」里能看到同一条摘要。
- 需要每月自动跑时，用外部 cron / systemd timer 调这条命令（本仓不带 scheduler）：
  ```cron
  10 0 1 * * cd /path/to/paimeng-ai-code-agent && npm run billing:quota-issue -- --apply
  ```
  时间取北京时间 1 号 00:10；即使漏跑或重跑，下一次任何人读额度摘要时也会补当期。

### 过期扫描

```bash
npm run billing:expire -- --dry-run   # 试运行：只报涉及人数
npm run billing:expire                # 真正写过期行（幂等）
```

- 每个已结束账期写一条负行；`create_time` 记为该账期结束时刻，流水按时间读才对。
- 懒触发已经覆盖单用户路径（摘要、管理员详情、结算、发放、冲正），这个命令用于停机跨月后一次性补齐，或交给外部 cron。
- 扫描没跑也不会多算：列表与单人读模型会扣掉「已到期但还没写过期行」的余量（与写入共用同一段 SQL 定义）。

### 核对

真值是账本；`credit_balance` 只是锁点与可重算快照。查某个用户：

```bash
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select id, kind, origin, credits, period, expires_at, reason, operator_id, create_time from credit_ledger where user_id = 123 order by create_time, id"
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select available, next_expiry_at, update_time from credit_balance where user_id = 123"
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select period, sum(credits) as remaining from credit_ledger where user_id = 123 and period is not null group by period order by period"
```

- 可用额 = 所有条目之和；负数表示欠款。限时 = 未到期账期的剩余；长期 = 可用 − 限时。
- 一个用户一个账期最多一条规则行、一条账期过期行；多行说明有人绕过 `ensurePeriodQuota` / `ensureExpiry` 直接写库。
- 对账：`npm run billing:verify-ledger` 逐用户比较快照与账本求和，`--apply` 按账本重写快照（账本一行都不改）。
- 有效期的展示口径：北京时间下一个 1 号 00:00，首页与对话页的额度条读的就是它。

## 补结算与余额对账

终态事务已提交、结算没落地（或进程正好在两者之间被杀）的 Generation 不会自己产生账单——没有别的路径会再通知计费。补结算把这类漏账补上，并给「缺费率」「晚到用量」的账单补差额。代码在 `src/server/billing/settlement.ts`；账本口径见 `src/server/billing/ledger.ts` 的注释与 [ADR-0004](adr/0004-credit-billing.md)。

### 扫描口径

只处理两类身份，重复扫描不会重复扣费（按 `usage_snapshot.stepId` 去重，差额只在总额层四舍五入一次）：

| 身份 | 条件 | 处理 |
| --- | --- | --- |
| 终态缺账 | `generation.status in ('ready','failed','cancelled')` 且没有 `credit_charge` 行 | 走首次结算：建账单、定价、分池扣款 |
| 待补账单 | `credit_charge.status in ('unpriced','partial')`，或模型步骤的 id 还没进 `usage_snapshot` | 只给「没进过账」的步骤补记差额，追加 `credit_entry` 后重算投影 |

- `generating` / `building` **永远不算终态**，扫描不碰。
- `reversed`（平台故障已整笔退还）的账单不再补扣，即使之后又出现晚到步骤。
- 补结算只追加 entry，不改写已计价步骤、不重排 `generation_id` 唯一的那张账单；金额为 0 的补记不写 entry。
- 缺价或缺估算样本时账单保持 `unpriced`/`partial`，原因写进 Admin 列表与扫描结果；先按[缺价处理](#缺价处理)核对步骤时间与 JSON 价格版本，或补齐可用用量样本，再试运行核对补结算范围。当前 Admin 只追加现在生效的单价，不能直接修复历史缺价。

### 什么时候会跑

没有常驻定时器，三个入口都调同一个幂等函数：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 启动屏障 | `durable-engine.ts` 的 `ensureRecovered()` | 恢复完成后跑一次 `reconcileSettlements({ limit: 50 })`，`void` + 记日志，失败不影响恢复 |
| Admin | `GET` / `POST admin/billing/reconcile` | 页面 `/admin/billing` 的「补结算与核对」分区：列待处理、按条或整批重试 |
| CLI | `npm run billing:reconcile` | 见下节；批量补也可以用外部 cron 调它 |

### CLI

前提：产品库已经迁移到最新（`npm run db:migrate`），补结算要用的 `credit_charge` / `credit_entry` 才存在。

```bash
cd paimeng-ai-code-agent
npm run billing:reconcile                          # 试运行：列出待补结算的记录与原因
npm run billing:reconcile -- --apply               # 执行补结算
npm run billing:reconcile -- --apply --limit=200   # 一次最多处理 200 条（默认 50，上限 200）
npm run billing:reconcile -- --user 123            # 核对某个用户的可用积分
npm run billing:reconcile -- --user 123 --apply    # 按账本重写该用户的余额快照
```

- 默认试运行，`--apply` 才写库；脚本自己校验目标库只能是 `paimeng_app` 或 `paimeng_app_test`。
- `--user` 只核对，不动账；带 `--apply` 时才重写 `credit_balance` 快照（`credit_ledger` 永不 UPDATE/DELETE）。
- 需要定期补时用外部 cron 调 CLI（本仓不带 scheduler），例如每小时一次：
  ```cron
  7 * * * * cd /path/to/paimeng-ai-code-agent && npm run billing:reconcile -- --apply
  ```

### 余额核对与修复

预期余额由账本事实推出（`ledger.ts` 的 `expectedBalancesOf`）：

- 可用额 = `credit_ledger` 所有条目之和；可以是负数（欠款）。
- 限时积分 = 到期时间还没到的账期剩余；长期积分 = 可用额 − 限时积分。过期行写入前，读模型会扣掉未写出的余量。

`auditAccount(userId)` 只报告 `expected` / `actual` / `diff`（`diff = actual − expected`），不写库。修复用 `rebuildBalance(userId)`：先锁行、补过期，再按账本重写快照——差异能由账本解释，账本行本身一行都不改。手工改 `credit_balance` 抹平差异属于事故，不是修复。

### 排查

```bash
# 某条账单的步骤身份与状态
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select generation_id, status, credits, jsonb_array_length(usage_snapshot) from credit_charge where generation_id = '<id>'"
# 某条账单的分录（正扣负退）
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select id, pool, credits, reason, create_time from credit_entry where charge_id = '<id>' order by id"
```
