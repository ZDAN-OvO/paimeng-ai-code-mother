# 验证记录：billing-rate-card.spec.ts

- 运行时间：2026-11-02T07:03:43.870Z
- 退出码：0
- 代码版本：e85a9e0
- Node：v24.20.0
- spec：`../../../../../tests/e2e/billing-rate-card.spec.ts`

## 这次证明的是什么

管理员在 `/admin/modelManage` 的 Rate card 看到一条未关联模型的历史费率；随后给一个已登记模型追加两个生效时间的版本，旧版本保留且不再是「现行」，第二个版本成为现行。

## 运行事实

- 命令：`npm run test:e2e:isolated -- tests/e2e/billing-rate-card.spec.ts`
- 实例：应用 http://localhost:3020，预览 http://127.0.0.1:3021，harness http://127.0.0.1:39911
- Playwright：2 passed，总耗时 3.1s
  - 通过 tests/e2e/billing-rate-card.spec.ts:88:1 › 管理员追加费率版本，历史版本仍然在表里（2.6s）
  - 通过 tests/e2e/billing-rate-card.spec.ts:119:1 › 未登录访问费率表被拒绝（43ms）

本次产物：

- `artifacts/26-11-02/billing/rate-card-legacy.png` — 277963 B，1280×1864
- `artifacts/26-11-02/billing/rate-card-versions.png` — 301496 B，1280×1993
- `run.log` — 2490 B
- 本机完整包另含 Playwright HTML/trace；docs 副本省略，保留截图、报告与 `run.log`。

## 结论与证据

| # | 结论 | 证据 | 断言源码 | 如果坏了会看到什么 |
| --- | --- | --- | --- | --- |
| 1 | 历史费率行仍显示在表里，并明确标记「历史费率，未关联模型」，不会伪装成当前模型价格 | [rate-card-legacy.png](artifacts/26-11-02/billing/rate-card-legacy.png) | [billing-rate-card.spec.ts:98](../../../../../tests/e2e/billing-rate-card.spec.ts) | 旧行被隐藏或没有标记，管理员会把它当成已关联模型的当前价 |
| 2 | 追加第一个版本 `100 / 10 / 400` 后，该行出现「现行」标记 | [rate-card-versions.png](artifacts/26-11-02/billing/rate-card-versions.png) | [billing-rate-card.spec.ts:105](../../../../../tests/e2e/billing-rate-card.spec.ts) | 新价写入后没有现行标记，或价格没有显示为 100 |
| 3 | 追加更晚的 `200 / 20 / 800` 后，旧行仍在、金额仍是 100，但不再是现行；新行成为现行 | [rate-card-versions.png](artifacts/26-11-02/billing/rate-card-versions.png) | [billing-rate-card.spec.ts:113](../../../../../tests/e2e/billing-rate-card.spec.ts) | 旧行被覆盖或两个「现行」并存，历史账单失去可解释性 |
| 4 | 未登录直接访问费率接口返回 401 | [run.log](run.log) | [billing-rate-card.spec.ts:121](../../../../../tests/e2e/billing-rate-card.spec.ts) | 未登录也能读费率表，权限边界失效 |

## 步骤与截图

1. 测试用 SQL 预置唯一提供商与 `provider_model`，并插入一条 `provider_model_id = NULL` 的 `legacy-rate-model` 历史费率；通过 `/user/login` 界面登录管理员账号。
2. 打开 `/admin/modelManage`，Rate card 表显示三列费率、`1 Credit = ¥0.01`，以及带「历史费率，未关联模型」标签的旧行。截图：[rate-card-legacy.png](artifacts/26-11-02/billing/rate-card-legacy.png)。
3. 在「追加版本」表单选择唯一模型，填生效时间 `2020-01-01` 与 `100 / 10 / 400`，点击追加。表格出现该版本并带「现行」。
4. 再追加更晚的 `2021-01-01` 与 `200 / 20 / 800`。旧行仍在且金额仍是 100，但「现行」消失；新行金额为 200 且带「现行」。截图：[rate-card-versions.png](artifacts/26-11-02/billing/rate-card-versions.png)。
5. 未登录请求 `GET /api/admin/billing/rate-card`，返回 401（`run.log` 中第二个用例）。

## 界面代劳与边界

| 步骤 | 真实路径 | 本次怎么做的 | 这会影响什么结论 |
| --- | --- | --- | --- |
| 提供商/模型与历史费率预置 | 管理端登记模型后追加历史价 | `beforeAll` 直接写 `model_provider`、`provider_model`、`credit_rate_card` | 证明的是「费率表如何展示历史行、如何追加版本」，不证明这两条模型由 UI 创建；模型登记由 `model-manage` 证明覆盖 |
| 管理员登录 | `/user/login` | 接口注册后 SQL 授予 admin，再走登录界面 | 登录界面不是本 spec 的证明对象；权限边界由 `platform` 与 `model-manage` 覆盖 |
| 追加费率 | 管理端表单 | 全部通过页面输入与按钮完成；保存后页面重新读取费率表（reload 数据） | 无削弱 |
| 费率计价 | 真实结算 | 本 spec 只验证管理界面，不涉及生成/结算 | 按模型 ID 的结算正确性由 integration billing 覆盖 |

## 副作用

无副作用（持久）：测试数据只落在 `_test` 库，`afterAll` 删除本测试的费率和临时提供商/模型。

```text
# 运行后查询 _test
model_alias 0 provider_model 0 credit_rate_card 2
```

剩余 2 条 `credit_rate_card` 是迁移 `008` 的初始历史费率，不是本 spec 创建的数据。

## 没覆盖的地方

- 按 `provider_model_id` 选择历史版本、跨生效时刻与补结算的正确性；这些由 `tests/integration/billing` 覆盖。
- 真实上游价格与成本；本 spec 只验证界面展示。
- 480 宽下的费率表布局；窄屏由 `model-manage` 的 480 截图覆盖，费率表未单测。
- 键盘全路径与读屏器。

## 你可以自己复核

1. 打开 [rate-card-legacy.png](artifacts/26-11-02/billing/rate-card-legacy.png)：`legacy-rate-model` 行应带「历史费率，未关联模型」标签，且当前价列是 10 / 1 / 40。
2. 打开 [rate-card-versions.png](artifacts/26-11-02/billing/rate-card-versions.png)：应有两行同一模型，`2020-01-01` 行金额 100 无「现行」，`2021-01-01` 行金额 200 带「现行」。
3. 对照 [billing-rate-card.spec.ts:105](../../../../../tests/e2e/billing-rate-card.spec.ts) 与 [billing-rate-card.spec.ts:113](../../../../../tests/e2e/billing-rate-card.spec.ts)：前者断言第一个版本现行，后者断言旧版本不再现行。
4. 重跑：`bash .pi/skills/verify-paimeng-agent/run-proof.sh tests/e2e/billing-rate-card.spec.ts`。
