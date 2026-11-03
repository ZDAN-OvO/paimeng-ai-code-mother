# 单账本额度：把「限时积分」收成积分的一种

状态：**实施中**（2026-11-03，P1–P6 已落地，待真实结算一轮后执行 025 删旧表）。结构已选定原型 A（`docs/prototypes/archive/credit-ledger/`，主从账本）；过期按**落一条显式条目**处理（见 §3.6）。

基线：`main@b44f4b9`。工作区里已有该原型目录、本计划；产品代码尚未改动。

## 1. 结论

删掉「配额池 / 余额池」这对概念，只留**一张追加式账本**：每条记录都是积分，`kind` 说明来源、`expires_at` 说明「限时 / 长期」。于是：

- 可用额只有一个数：**账本条目的和**。界面上的「限时积分 / 长期积分」是同一个数按到期时间分出来的两段，不是两个池。
- 扣减顺序只有一条：**先扣最临近到期的**，扣完限时再扣长期。
- 过期是一次**真实的入账**：账期切换后把上期剩下来的限时积分写成一条负条目，表里查得到、页面看得见，而不是隐式消失也不是纯计算。
- 配额侧的 5 张表收敛成 1 张规则表 + 账本行；`已发 / 待发 / 调整 / 批次` 全部变成「有没有本期条目」和「条目金额」。
- 批量发放、过期扫描这类**动作**留一张摘要日志（`credit_operation`），这样去掉批次表之后仍然查得到「谁在什么时候批量发了多少、谁失败了」。

页面按 A 重建：左边人（可筛欠款/待发）、右边一本流水、两个发放弹窗（发放积分 / 发放限时积分）；「配额管理」页签消失。

## 2. 现在的事实

### 2.1 表

| 表 | 现在的职责 | 问题 |
| --- | --- | --- |
| `credit_grant` | 入账唯一入口，`pool` + `source` | 同一笔积分要带池属性 |
| `credit_account` | 每用户每池一行余额快照 | 池语义渗进结算、对账、读模型 |
| `credit_quota_issue` | 每用户每账期的发放事实（0 也写） | 与 `monthly_quota` grant 重复表达「发过」 |
| `credit_quota_adjustment` | 当月手动加/减 | 只是另一种入账 |
| `credit_quota_batch` / `_batch_item` | 批量发放预览与逐用户回执 | 规则发放本该幂等直接跑；摘要由 `credit_operation` 承担 |
| `credit_quota_policy` | 每月额度规则（版本化） | **保留**，语义改成「每月自动发放多少限时积分」 |
| `credit_charge` / `credit_entry` | 出账聚合根 + 分池分录 | 分录按池拆，正是要取消的东西 |
| `credit_rate_card` | 定价 | 不动 |

### 2.2 三处「同一个事实写三遍」

- `src/server/billing/quota-facts.ts` 自己算一套：`基础 + 调整 − 当期消费`。
- `src/server/billing/ledger.ts` 的 `expectedBalancesOf` 同时读 grant、entry、`quotaFactsOfPeriod`。
- `src/server/billing/overview.ts` 用多段 CTE 从 grant / entry / issue / adjustment 四类事实拼全库统计。

结算侧 `chargePools` 按两池拆分录；冲正侧 `reverseChargeTx` 还要判断「这块配额是不是还在当期，才决定退不退」——这一条判断本身就是为了补池语义的洞。

### 2.3 页面

`/admin/billing` 两个页签，配额管理页上依次是：5 张统计卡、全局策略、单用户覆盖、策略版本、当月调整、批量预览/执行/重试、批次记录、发放与待发。这就是「看不懂」的直接原因。

## 3. 目标模型

### 3.1 新表 `credit_ledger`（追加式，唯一真值）

字段（最终 DDL 以迁移文件为准）：

```
id            bigserial pk
user_id       bigint not null
kind          quota | topup | grant | consume | refund | expire
origin        rule | manual | payment | charge | expiry | reversal
credits       bigint not null          -- 有符号；consume / expire 为负，refund 为正
period        'YYYY-MM' null           -- quota / 由它拆出的 consume / refund / expire
expires_at    timestamp(3) null        -- quota 及其扣减/退回/过期条目
charge_id     varchar(36) null         -- consume / refund 指向 credit_charge
reversal_of   bigint null              -- refund 指向被冲正的 consume
reason        text
operator_id   bigint
request_id    varchar(128)             -- 手动发放幂等
ref           varchar(128)             -- 支付单号等外部引用
create_time   timestamp(3) not null
```

索引与唯一键：

- `(user_id, id)`：按用户回放流水。
- `(user_id, period)`：算每个账期的发放/消费余量（过期条目要用）。
- `(charge_id)`：按账单取分录。
- `unique (user_id, period) where kind='quota' and origin='rule'`：规则发放每期只有一条，重跑天然幂等。
- `unique (user_id, period) where kind='expire' and origin='expiry'`：账期切换的过期条目只写一条；冲正引发的过期用 `origin='reversal'`，不在这条唯一键里。
- `unique (user_id, request_id) where request_id is not null`：手动发放幂等。
- `unique (reversal_of) where reversal_of is not null`：一笔分录只退一次。
- 约束：`kind='quota'` 必须有 `period` 与 `expires_at`；`kind='consume'|'refund'` 必须有 `charge_id`；`credits` 只有 `kind='quota' and origin='rule'` 允许为 0（见 R4）。

### 3.2 新表 `credit_balance`（锁点 + 快照）

`(user_id pk, available bigint not null, next_expiry_at timestamp(3) null, update_time)`。

- 结算 / 发放 / 冲正时 `FOR UPDATE` 的行锁点（一个用户一行，不再有「先锁哪一行」的排序问题）。
- 快照与「下一个账期边界」`next_expiry_at`：`now < next_expiry_at` 时快照等于账本求和，可直接读（运行时熔断每一步都要读一次，走快照才不热）；一旦越过边界，快照作废，按账本重算并（视调用方）回写。

写入路径一律在锁内**从账本重算**再写快照，不做增量加减；对账命令仍以账本为准报告漂移。ADR-0004 的「快照不是真值」继续成立。

### 3.3 `credit_quota_policy` 原样保留

只改对外文案语义：规则 = 「每月自动发放多少限时积分」。仍只允许未来账期、仍按 `(effective_period, revision)` 追加。当月要改某个人，走「发放限时积分」。

### 3.4 旧 → 新映射

| 旧 | 新 |
| --- | --- |
| `credit_grant` source=monthly_quota | `kind='quota'`, `origin='rule'`, `period`, `expires_at=账期结束` |
| `credit_quota_adjustment` | `kind='quota'`, `origin='manual'`, 差额，`expires_at=账期结束` |
| `credit_grant` source=purchase | `kind='topup'`, `origin='payment'`, `ref` |
| `credit_grant` source=admin_grant | `kind='grant'`, `origin='manual'` |
| `credit_quota_issue`（0 额度） | `kind='quota'`, `origin='rule'`, `credits=0` 的标记行 |
| `credit_entry` pool=quota | `kind='consume'`, `period=账单所在账期`, `expires_at=该账期结束` |
| `credit_entry` pool=balance | `kind='consume'`, `expires_at=null` |
| `credit_entry.reversal_of` | `kind='refund'`, 继承原分录的 `period` / `expires_at` |
| 历史账期未用完的限时积分 | 每个已结束账期一条 `kind='expire'`, `origin='expiry'` 的负条目 |
| `credit_quota_batch` / `_batch_item` | `credit_operation` 一条摘要；逐用户结果 = 同一 `request_id` 的账本行 + 失败明细（历史批次不回填） |

### 3.5 新表 `credit_operation`（操作日志，不是钱）

批量与扫描类动作的摘要：

```
id            bigserial pk
kind          issue_pending | issue_users | expire_sweep
request_id    varchar(128)        -- 与 credit_ledger.request_id 对应
period        'YYYY-MM'
operator_id   bigint              -- CLI 为 null
target_count  int                 -- 选中 / 匹配人数
issued_count  int                 -- 实际写入条目的人数
skipped_count int
failed_count  int
credits       bigint              -- 本次实际写入的积分合计
status        running | completed | partial | failed
detail        jsonb               -- 失败明细 [{ userId, reason }]，上限 200 条
create_time   timestamp(3)
finish_time   timestamp(3)
```

先划清它**不是**什么：它不是旧的 `credit_quota_batch`——没有预览 token、没有逐用户回执、没有"继续执行"、不参与幂等。一次批量 = 一行摘要 + N 条账本行。

分工要说清楚，否则会变成第二份真值：

- **单笔操作不进这张表**：谁给谁发了多少、为什么、冲的哪一笔，`credit_ledger` 的 `operator_id` / `reason` / `request_id` / `charge_id` / `reversal_of` 已经写全了。
- **这张表只是摘要**：人数与金额永远可以按 `request_id` 从账本重算；日志写失败或停在 `running` 不影响钱，只影响可读性，重算脚本可以补。
- **规则修改也不进这张表**：`credit_quota_policy` 自己带 `created_by` / `create_time` / `revision` / `note`。

### 3.6 过期怎么写

过期是一条真实条目，因此必须有东西写它。三条路径共用同一个函数（`ensureExpiry(userId, at)`）：

1. **懒触发**：本人读额度摘要、管理员打开某个人的详情、该用户发生结算/发放/冲正时，先补写该用户所有已结束账期的过期条目。
2. **批量兜底**：`npm run billing:expire` 扫全库（可交给外部 cron，和现有的 `billing:quota-issue` 同一套部署方式）。
3. **读模型修正**：列表页（全库）不逐用户写库，但计算可用额时把「已结束账期里还没写过期条目的余量」扣掉。这样即使批量兜底没跑，页面上的数也不会多出来。每次 CLI 扫描写一条 `kind='expire_sweep'` 的操作日志。

过期金额 = `该账期发放合计 − 该账期消费净额 − 该账期已过期金额`，取正数部分写负条目；其中「消费净额」= `consume` 与 `refund` 之和的相反数，「已过期金额」= 该账期所有 `expire`（含冲正引发的）之和的相反数。`create_time` 记账期结束时刻，所以流水按时间读是对的。重复触发不会写第二条，幂等由 §3.1 的唯一键保证。

## 4. 规则（每条都要有测试）

- **R1 可用额** = 账本所有条目的和（`expire` 条目也在里面）。负数合法（欠款）。写入 `expire` 之前，读模型按 §3.6 扣除未写出的过期余量，所以任何时刻读到的数都等于「假想过期已写」的结果。
- **R2 扣减顺序**：到期早的先扣；同一到期时刻按 `id` 升序。结算时从「未过期 quota 余量」里按此顺序取，不够才写 `expires_at=null` 的那一笔。
- **R3 过期的口径**：账期边界（北京时间 1 号 00:00）之后，上一个账期没花完的限时积分全部过期，写成一条负条目；不结转、不折现。过期条目对用户只说一句话："本月的限时积分没用完，清零了"。
- **R4 规则发放**：**已发 / 待发只看「本期有没有 `origin='rule'` 的 quota 记录」**，不看余额、不看金额。每人每期最多一条（唯一键保证）。规则金额为 0 时也写一条 `credits=0` 的回执行，`reason` 记「本月规则发放 0（暂停发放）」；它不进可用额，只是"这次规则处理过"的凭据。用户侧账单页过滤掉 0 金额行，管理员流水保留并置灰。这样「待发」名单不会因为某人的规则是 0 而永远挂着同一批人、每批都被重复扫描。
- **R5 手动发放**：`request_id` 幂等；限时发放必须落在当前账期（`expires_at=本账期结束`），跨期发放被拒。
- **R6 冲正**：为每条未冲正的 consume 追加一条同额正数 `refund`，**继承原 `period` / `expires_at`**。若原桶已过期（该账期已写过过期条目），同事务再追加一条 `origin='reversal'` 的 `expire` 负条目把这次退回也清掉——账本上能看到「退回 +200 / 已过期 −200」，余额不变。这样既不需要「是否还在当期」的特判，也不会把已失效的积分复活成可用额度。
- **R7 透支**：公式不变（近 60 天 topup × 2%，封顶 500），基数来源从 `source='purchase'` 改为 `kind='topup'`。
- **R8 账期**：只由 `period` / `expires_at` 表达（北京时间自然月，`period.ts` 不变）；不存在「池重算」。
- **R9 读模型**：列表页统计走账本聚合 SQL（含 §3.6 的未写过期修正），不逐用户写库；单人/单步可用额优先读快照，但只在 `now < next_expiry_at` 时可信，否则重算（见 §3.2）。
- **R10 操作日志**：批量发放与过期扫描各写一条 `credit_operation`，与账本按 `request_id` 对得上；单笔操作不重复记。日志是摘要，删掉它能从账本重算出来，钱不受影响。

## 5. 迁移

### 5.1 `024_credit_ledger.sql`

建两张新表 → 按 §3.4 回填 → 为每个用户写 `credit_balance`（含 `next_expiry_at`）。回填**不删任何旧表**，旧表在这一步只是变成只读。

回填要点：

- 消费分录按「父 Charge 的 `create_time` 所属北京账期」归账期，与现有 `quotaFactsOfPeriod` 口径一致。
- 历史 `reversal_of` 原样保留；先插原始行再插反向行，`reversal_of` 回填后指向新 `credit_ledger.id`。
- 每个已结束账期补一条过期条目（§3.6 的公式），否则历史未用完的配额会在新账本里凭空变成可用额。

### 5.2 校验脚本 `scripts/ops/billing-verify-ledger.ts`

逐用户对比：

1. 旧口径：`expectedBalancesOf`（现有实现，迁移前先跑一遍存快照）。
2. 新口径：`credit_ledger` 聚合 + `credit_balance`。
3. 逐账单对比 `effectiveCreditsOf` 与 `Σ ledger(charge_id)`。

输出：总人数、差异人数、逐条差异（用户、旧值、新值、原因）。**差异必须为 0** 才能进下一步；允许白名单只针对「0 额度 issue 行」这类已知等价物。

### 5.3 `025_drop_legacy_credit_tables.sql`

在 024 + 服务端切换上线、跑过一轮真实结算与对账之后执行：删除 `credit_grant`、`credit_entry`、`credit_account`、`credit_quota_issue`、`credit_quota_adjustment`、`credit_quota_batch`、`credit_quota_batch_item`。

保留 `credit_charge`、`credit_rate_card`、`credit_quota_policy`。

### 5.4 回滚

024 是纯新增，回滚 = 代码回旧版 + 忽略新表；旧表在 025 之前一直完整可读。025 不可回滚，必须先有 5.2 的 0 差异报告并归档到 `docs/migrations/`。

## 6. 服务端改动

### 6.1 模块

| 动作 | 文件 |
| --- | --- |
| 重写 | `src/server/billing/ledger.ts`：`recordGrant` → `postEntry`；`chargePools` → `postConsume`（按 R2 取桶）；`reverseChargeTx` 按 R6；`expectedBalancesOf` / `rebuildAccount` 改为账本聚合 |
| 新增 | `src/server/billing/allocation.ts`：未过期桶、按到期顺序分配消费、算限时/长期拆分（纯函数 + 读取函数，便于单测） |
| 新增 | `src/server/billing/expiry.ts`：`ensureExpiry(userId, at)` 与「未写过期余量」的 SQL 片段；**写路径与读修正共用这一个函数**，避免两处各算一遍 |
| 新增 | `src/server/billing/operations.ts`：写 `credit_operation`（批量/扫描）、按 `request_id` 从账本重算摘要、查最近记录 |
| 重写 | `src/server/billing/quota.ts` → 只保留 `issueRulePoints` / `ensureCurrentPeriod` / `issuePending`（规则发放 + 懒发放 + 批量补发；删除 issue/adjustment/batch 三件套），发放前先 `ensureExpiry` |
| 删除 | `quota-facts.ts`、`quota-adjustment.ts`、`quota-batch.ts` |
| 重写 | `overview.ts`：一段账本聚合 SQL 出列表、统计、筛选（`debt` / `pending` / `extra`）、单人详情（含未写过期修正） |
| 调整 | `admin.ts`：`grantCredits` 收 `kind` + `expiresAt`，不再有 `pool`；`userUsage` 返回单账本视图 |
| 保留 | `settlement.ts`（只替换扣减/冲正调用，并在扣减前 `ensureExpiry`）、`pricing.ts`、`rate-card.ts`、`period.ts`、`quota-policy.ts`（只改文案与注释） |
| 重写 / 新增 | `scripts/ops/billing-quota.ts` 仍按「补发待发」工作；新增 `scripts/ops/billing-expire.ts`（`npm run billing:expire`）与 5.2 校验脚本 |
| 文档 | `docs/billing-operations.md` 按新规则重写「月度配额」一节；`GLOSSARY.md` 的 Credit pool / balance / grant / entry 条目改为积分 / 限时积分 / 长期积分 / 条目 |

### 6.2 API

| 端点 | 变化 |
| --- | --- |
| `GET billing/summary` | 返回 `{ available, limited, limitedExpiresAt, lasting, period, overdraft, purchasedCredits60d }`，删掉 `quota/balance/quotaBase/...` |
| `GET billing/charges` | 不变（分录改从新表读，按 charge 聚合成一行展示） |
| `GET admin/billing/overview` | 返回 `{ items: [{ userId, account, name, available, limited, lasting, status, issued, spent }], stats, page }`；`filter=all|debt|pending|extra`，`sort=` 保留 |
| `GET admin/billing/user/:id` | 新增：身份 + 余额拆分 + 本期发放/已用 + 最近条目 |
| `GET admin/billing/ledger?userId=` | 新增：该用户流水（分页，含过期行） |
| `POST admin/billing/issue` | 新增：`{ userId | userIds, kind: 'limited'|'lasting', credits, reason, requestId }`，返回逐用户回执 |
| `POST admin/billing/issue-pending` | 新增：按规则补发待发（原批量发放），返回 `{ operationId, count, credits, failures }` |
| `GET admin/billing/operations?limit=` | 新增：最近批量/扫描记录（谁、何时、几人、合计、状态、失败明细） |
| 保留 | `admin/billing/quota/policy`（规则读写）、`admin/billing/reconcile`、`admin/billing/charge/:id/reverse`、`admin/billing/rate-card`、`admin/billing/users`（搜索） |
| 删除 | `admin/billing/quota/adjust`、`admin/billing/quota/batch/preview|execute|retry`、`admin/billing/quota/batches` |

`src/shared/billing.ts` 里的 `CreditPool` / `poolLabels` / `poolOfSource` / `QuotaAdjustment*` / `QuotaBatch*` 类型一并删除；`AccountSummary`、`AdminCreditOverviewItem`、`AdminUserUsage` 按新字段重写。

## 7. 前端

### 7.1 管理员页（A）

- 路由不变：`src/app/admin/billing/page.tsx` → 新的单页组件。
- 新增 `src/components/billing/credit-page.tsx`（布局与状态）、`credit-user-list.tsx`（搜索 + 全部/欠款/待发 + 底部计数）、`credit-ledger.tsx`（流水表 + 表头吸顶）、`credit-grant-dialog.tsx`（两种发放共用一个弹窗）、`credit-rule-dialog.tsx`（改规则）、`credit-detail.tsx`（账单与冲正，复用现有 `reconcile-panel.tsx` 的抽屉）。
- 删除 `billing-manager.tsx`、`credit-management-panel.tsx`、`quota-management-panel.tsx`、`admin-credit-overview.tsx`、`quota-detail-panel.tsx`、`grant-panel.tsx`。
- 保留 `user-search-select.tsx`（改接新接口）、`admin-usage-panel.tsx`（按新数据结构改写）、`reconcile-panel.tsx`、`rate-card-panel.tsx`（仍在模型管理页）。
- 布局：两栏底边对齐、各自内部滚动、页面不滚（原型 A 的约束）。断点 ≤980px 堆叠。

### 7.2 用户侧

- `credit-balance.tsx`：从「两池 + 合计 + 本期配额」改成「可用 / 限时（到期时间）/ 长期」。
- `billing-history.tsx`、`insufficient-credits.tsx`、我的账单页文案统一「积分 / 限时积分 / 长期积分」。
- 全站用户可见文案不再出现 Credit（`src/shared/billing.ts` 里的 `labels` 一起改）。

### 7.3 交互规格（对齐原型，逐条可验）

1. 左列：搜索、`全部 / 欠款 / 待发` 筛选、选中态、底部「共 N 人」。
2. 顶部摘要里的「N 人欠款」「N 人待发」可点击 → 切筛选并选中第一个匹配。
3. 右栏：身份 + 可用额 + 限时/长期/本月已用 + 两个发放按钮 + 账单与冲正。
4. 发放弹窗：数量（快捷 100/500/1000/5000）、理由、限时/长期说明、Enter 提交、非法值为 0/负数拦截。
5. 流水：每行时间、标签、金额（有符号）、累计结余；过期行是真实条目，置灰并写「本月限时积分没用完」。
6. 空态：未发用户显示 0 可用 + 「发放限时积分」入口，并说明「0 不是花完了」。
7. 错误：接口失败用 antd message，不静默。
8. 页面头部一个「最近操作」入口 → 抽屉列出最近 20 条批量/扫描记录（时间、操作人、范围、人数、合计、状态、失败原因）；单笔发放不在这里重复，去该用户流水里看。**这条是原型 A 上加的**：原型里没有日志表，A 的布局不变，只多一个入口。

## 8. 测试与验收

### 8.1 单元 / 集成

- 新增 `tests/unit/billing/allocation.test.ts`：到期顺序、跨桶拆分、过期余量公式、冲正继承到期时间。
- 新增 `tests/unit/billing/expiry.test.ts`：过期金额计算、重复调用只写一条、部分消费后用剩余额。
- `tests/support/billing.ts` 的夹具改成写新账本（`postEntry` / `postConsume`），不要在用例里手写 SQL。
- `tests/integration/billing/`：重写 `settlement`、`grants`、`quota`、`overview`、`admin-usage`、`reconcile`、`admission`、`overdraft`；删除 `quota-adjustment`、`quota-batch`。新增「跨账期」用例：结算 → 时间推进到边界 → `ensureExpiry` → 余额与条目断言。
- 新增 `tests/integration/billing/operations.test.ts`：批量发放写一条日志且人数/金额与同 `request_id` 的账本行一致；删掉日志行后能从账本重算出来；失败项进 `detail`。
- 迁移专项：在 `_test` 库上回放旧结构 + 夹具数据 → 跑 023 → 断言新账本（含过期行）与旧事实一致（用 5.2 的同一函数）。

### 8.2 E2E

- 重写 `tests/e2e/billing-admin-overview.spec.ts`（新页面：筛选、弹窗、发放后余额与流水）、`billing-balance.spec.ts`、`billing-ledger.spec.ts`、`generation-credit.spec.ts`、`overdraft.spec.ts`；`admin-parity.spec.ts` 里涉及两个页签的断言同步改。
- 删除 `billing-quota-policy/adjustment/batch.spec.ts`，规则与补发并入新页面用例。
- 证据用本机 `verify-paimeng-agent` 技能（`.pi/skills/`，仅本机）出包（截图 + 断言源码行 + 产物），覆盖：初始态 → 筛欠款 → 发放限时积分 → 流水变化 → 刷新仍一致 → 结算扣减 → 冲正。

### 8.3 验收标准（用户可见）

1. 用户侧只显示「可用 / 限时 / 长期」三个数，且与账本求和一致。
2. 管理员两次点击「发放限时积分」500 + 300，账本出现两条条目，限时余额 +800，摘要同步。
3. 跨账期（用可控时间）：上期未用完的限时积分在账本里生成一条 `expire` 负条目；重复触发不重复写；余额与条目和一致。
4. 结算先扣最临近到期的；一次生成跨越两个桶时，账单里能看到两段。
5. 冲正后，仍未过期的部分回到原桶；已过期的部分同事务写「退回 + 过期」，余额不变。
6. 规则发放连跑三次只发一次；规则为 0 的用户有一条 0 金额回执行（用户侧账单看不到、管理员流水看得到），且不会每次都留在待发名单里被重复扫描。
7. 全库统计 = 逐用户明细求和（同一 SQL 口径，脚本可验）；批量兜底没跑时，列表统计也不多算。
8. 旧表删除后 `rg "credit_grant|credit_quota_issue|credit_quota_adjustment|credit_quota_batch" src scripts tests` 无残留。
9. 批量发放后「最近操作」里有一条记录，人数/合计与同一 `request_id` 的账本行一致；删掉这条日志，重算脚本能还原同样的数字（证明它不是第二份真值）。
10. `npm run type-check`、`check:ui`、`check:e2e`、`test:all`、`test:e2e:isolated` 全绿。

## 9. PR 拆分

| # | 内容 | 可独立合并 |
| --- | --- | --- |
| P1 | 本计划 + ADR-0006 + GLOSSARY/术语 | ✅ |
| P2 | `credit_ledger`/`credit_balance` schema + `allocation.ts` + `expiry.ts` + 单测（不接线） | ✅ |
| P3 | 迁移 024 + 回填（含历史过期行）+ 校验脚本 + 迁移专项测试 | ✅ |
| P4 | 服务端切换到新账本（ledger/settlement/quota/expiry/operations/overview/admin/API/CLI） | ✅ 与 P3 同批 |
| P5 | 管理员页 A + 用户侧文案 | ✅ |
| P6 | E2E 重写 + 证据包 + 删除旧组件 | ✅ |
| P7 | 迁移 025 删旧表 + 文档收尾 + 原型归档 | 待真实结算一轮 |

## 10. 风险

1. **钱算错**：结算/冲正是资金路径。缓解：P2 的纯函数单测先覆盖到期顺序与冲正；迁移差异报告必须为 0；保留旧表一个发布周期。
2. **过期行漏写**：`ensureExpiry` 没被触发时，账本会停在「过期还没入账」。缓解：读模型同时扣除未写过期余量（§3.6），页面永远不多算；CLI 兜底可交给 cron；集成用例覆盖「没跑兜底仍然读对」。
3. **回填口径漂移**：`pool=quota` → 账期桶的映射依赖「父 Charge 的账期」，历史过期行也要按同一公式补；与现有 `quotaFactsOfPeriod` 必须逐用户对上，5.2 脚本是硬门槛。
4. **读模型与快照不一致**：快照带 `next_expiry_at`，越过边界即作废；列表统计一律走账本聚合。写路径在锁内重算快照，漂移由对账命令报告，不静默。
5. **并发**：单行 `credit_balance` 锁降低了互等风险，但 `postConsume` 要在锁内读桶并写多条分录，事务时长略有增加；用 200 并发发起的冒烟用例确认无死锁，过期写入用唯一键冲突兜底。
6. **页面回归**：新页面替换两个页签，权限、空态、错误态要一并覆盖；用隔离 E2E 全走一遍。
7. **批量发放语义变化**：去掉预览 → 直接幂等执行。若需要「先看再发」，在 UI 上用一次查询展示人数/合计做确认，不入库。
8. **操作日志与账本对不上**：日志是最终一致（先建 `running`，逐人发完再收口）。金额与人数一律以账本按 `request_id` 重算为准；对不上时重算脚本回写，不让日志成为第二个真相。

## 11. 已定 / 待定

已定：

- **过期落表**：账期边界写一条 `expire` 负条目（`origin='expiry'`），懒触发 + CLI 兜底 + 读修正，见 §3.6。
- **批量发放**：去预览，直接幂等执行；确认信息由一次查询得出，不入库。
- **内部标识符**：本轮只改对外文案，`credit_*` 表名与 TS 标识符不动；「积分」改名留给后续独立迁移。
- **操作日志**：建 `credit_operation`，只记批量与扫描，单笔靠账本自身字段；日志可从账本重算（§3.5）。它不是批次表。
- **0 额度**：规则发放 0 也写一条 0 金额回执行；「已发」判定只看记录存在，不看金额（R4）。

待拍板：

（暂无。剩余实现细节在 P2 里按代码现状决定，不影响验收口径。）

## 12. ADR

落地前写 `docs/adr/0006-single-credit-ledger.md`，取代 ADR-0004 中「Two pools, deducted quota first」一节与 ADR-0005 的 issue/grant 事实模型；保留其「Credit 单位」「Rate card」「结算在终态之后」「透支是熔断线」「只追加」这些仍然成立的结论。

## 13. 实施记录

- 迁移：`024_credit_ledger.sql` 在本地 `paimeng_app` 演练通过（202 条规则行、1 条充值、202 行快照；用户 1 可用 1,000,500）。
- 服务端：`ledger.ts` / `expiry.ts` / `allocation.ts` / `quota.ts` / `operations.ts` / `overview.ts` 重写；结算与冲正改走 `postConsume` / `reverseChargeTx`。
- 页面：`credit-page.tsx` 主从账本替换两个页签；发放弹窗、规则弹窗、最近操作、账单冲正、补结算抽屉。
- 验证：`npm test` 496 passed；`npm run test:integration` 475 passed / 1 skipped；`type-check`、`check:fast` 通过；E2E 证据包见 PR 评论。
- 待办：025 删旧表（需真实结算一轮 + 0 差异对账）；原型归档。
