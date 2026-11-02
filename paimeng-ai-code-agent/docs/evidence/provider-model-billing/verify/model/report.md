# 验证记录：model-manage.spec.ts

- 运行时间：2026-11-02T07:00:36.323Z
- 退出码：0
- 代码版本：e85a9e0
- Node：v24.20.0
- spec：`../../../../../tests/e2e/model-manage.spec.ts`

## 这次证明的是什么

管理员在 `/admin/modelManage` 看到同一请求名在两家提供商下是两条模型身份，把代码生成槽位切到第二家，并确认槽位弹窗只读模型能力、480 宽仍能操作；随后从受控上游候选登记一个新模型并分配给槽位。

## 运行事实

- 命令：`npm run test:e2e:isolated -- tests/e2e/model-manage.spec.ts`
- 实例：应用 http://localhost:3020，预览 http://127.0.0.1:3021，harness http://127.0.0.1:34655
- Playwright：11 passed，总耗时 34.1s
  - 通过 tests/e2e/model-manage.spec.ts:105:1 › 未初始化时显示初始化提示，不提供编辑器也不要求密钥（1.8s）
  - 通过 tests/e2e/model-manage.spec.ts:144:1 › 管理员可编辑提供商与槽位分配并普通保存（2.7s）
  - 通过 tests/e2e/model-manage.spec.ts:195:1 › 能力与回传思考内容属于提供商模型，槽位只选模型并保留自己的参数（4.1s）
  - 通过 tests/e2e/model-manage.spec.ts:249:1 › 同一请求名在两家提供商下是两条身份，槽位按提供商选择（2.9s）
  - 通过 tests/e2e/model-manage.spec.ts:295:1 › 直接输入的密钥以密文入库，界面与接口都不回显明文（2.1s）
  - 通过 tests/e2e/model-manage.spec.ts:337:1 › 版本冲突时保留表单输入并可重新加载（2.0s）
  - 通过 tests/e2e/model-manage.spec.ts:371:1 › 保存并立即生效与立即生效递增刷新批次（1.9s）
  - 通过 tests/e2e/model-manage.spec.ts:401:1 › 普通用户不能打开模型管理页面（979ms）
  - 通过 tests/e2e/model-manage.spec.ts:412:1 › 连通性检测与获取模型在界面上给出反馈（3.9s）
  - 通过 tests/e2e/model-manage.spec.ts:436:1 › 从上游候选登记模型并分配给槽位（2.6s）
  - 通过 tests/e2e/model-manage.spec.ts:491:1 › 自定义请求头可增删、保存后随探测请求发送（8.3s）

本次产物：

- `artifacts/26-11-02/provider-model/narrow-480.png` — 251171 B，480×2718
- `artifacts/26-11-02/provider-model/same-name-two-providers.png` — 312816 B，1280×1995
- `artifacts/26-11-02/provider-model/slot-model-readonly.png` — 342698 B，1280×1892
- `artifacts/26-11-02/provider-model/upstream-candidates.png` — 327445 B，1280×1892
- `run.log` — 3739 B
- 本机完整包另含 Playwright HTML/trace；docs 副本省略，保留截图、报告与 `run.log`。

## 结论与证据

| # | 结论 | 证据 | 断言源码 | 如果坏了会看到什么 |
| --- | --- | --- | --- | --- |
| 1 | 同一请求名 `test-codegen-model` 在 `env-default` 与 `env-secondary` 下显示为两条模型记录，页面同时显示提供商 ID | [same-name-two-providers.png](artifacts/26-11-02/provider-model/same-name-two-providers.png) | [model-manage.spec.ts:267](../../../../../tests/e2e/model-manage.spec.ts) | 只剩一行，或两行无法区分提供商，同名模型被错误合并 |
| 2 | 槽位切到第二提供商后，数据库 `model_alias.provider_id` 和 `provider_model_id` 都指向 `env-secondary` 的模型 | [same-name-two-providers.png](artifacts/26-11-02/provider-model/same-name-two-providers.png) | [model-manage.spec.ts:282](../../../../../tests/e2e/model-manage.spec.ts) | 槽位仍停在 `env-default`，或只改了显示名没有改模型身份 |
| 3 | 槽位弹窗只显示模型能力和兼容声明，没有能力/回传开关；模型级「回传思考内容」保存进 `provider_model.compatibility` | [slot-model-readonly.png](artifacts/26-11-02/provider-model/slot-model-readonly.png) | [model-manage.spec.ts:219](../../../../../tests/e2e/model-manage.spec.ts) | 槽位弹窗仍出现能力开关，能力被写成别名级配置而不是模型级 |
| 4 | 从受控上游候选登记 `mimo-v2.6-flash`、勾选能力并分配给代码生成后，`model_alias.provider_model_id` 等于新建模型 ID | [upstream-candidates.png](artifacts/26-11-02/provider-model/upstream-candidates.png) | [model-manage.spec.ts:480](../../../../../tests/e2e/model-manage.spec.ts) | 槽位仍保存手填名称，或新建模型没有真正成为槽位身份 |
| 5 | 480 宽下页面主区域可见且页面本身没有横向溢出 | [narrow-480.png](artifacts/26-11-02/provider-model/narrow-480.png) | [model-manage.spec.ts:291](../../../../../tests/e2e/model-manage.spec.ts) | `document.documentElement.scrollWidth - innerWidth` 大于 1，页面出现整页横向滚动 |

## 步骤与截图

1. 测试用 SQL 预置 `env-default` 与 `env-secondary` 两家提供商，并在两家下各插入请求名 `test-codegen-model` 的模型记录（`seedModelConfig` + 额外 provider/model insert）。
2. 打开 `/admin/modelManage`。模型表出现两条 `test-codegen-model`，提供商列分别显示 `env-default`、`env-secondary`，槽位卡片显示各自引用的模型。截图：[same-name-two-providers.png](artifacts/26-11-02/provider-model/same-name-two-providers.png)。
3. 打开「代码生成」槽位，选择 `第二提供商 / test-codegen-model` 并保存。页面提示「模型分配已保存」，槽位卡片显示第二提供商；随后查询 `model_alias` 确认 `provider_id=env-secondary`、`provider_model_id=910000000000000001`。
4. 将视口切到 480×900，`page.reload()` 后仍能看到「提供商模型」区域，页面宽度断言通过；截图：[narrow-480.png](artifacts/26-11-02/provider-model/narrow-480.png)。
5. 在模型编辑弹窗把 `test-codegen-model` 的「模型回传思考内容」打开并保存；页面提示「提供商模型已保存」。打开代码生成槽位，弹窗显示能力标签与费率，不出现能力开关；截图：[slot-model-readonly.png](artifacts/26-11-02/provider-model/slot-model-readonly.png)。
6. 打开「登记提供商模型」，点击「获取上游候选」，受控 HTTP 服务返回 `mimo-v2.6-flash` 与 `deepseek-flash`；候选区显示并标出已登记项，截图：[upstream-candidates.png](artifacts/26-11-02/provider-model/upstream-candidates.png)。
7. 点击 `mimo-v2.6-flash` 填入请求名，打开流式与工具调用能力，保存后再次打开代码生成槽位，选择该模型并保存；查询 `model_alias` 确认 `provider_model_id` 等于新模型 ID。

## 界面代劳与边界

| 步骤 | 真实路径 | 本次怎么做的 | 这会影响什么结论 |
| --- | --- | --- | --- |
| 预置两家提供商与同名模型 | 管理员在「新增提供商 / 登记模型」里操作 | `tests/e2e/support/model-config-fixtures.ts` 的 `seedModelConfig` + 测试内 SQL 直接写 `model_provider` / `provider_model` | 证明的是「已有两条同名模型时界面可辨、槽位可选」，不证明这两条一定由本页面的登记流程创建；后者由第 6–7 步覆盖 |
| 管理员登录与角色 | `/user/register` → 管理端菜单 | 测试用 `page.request` 注册后直接 `UPDATE app_user SET user_role` | 登录界面本身不是本 spec 的证明对象；权限边界由现有 `platform`/`model-manage` 用例覆盖 |
| 上游候选 | 真实上游 `GET /models` | 测试内启动受控 HTTP 服务返回固定两条模型 | 证明候选发现与登记交互，不证明真实提供商的能力或推理结果 |
| 数据库断言 | 管理端保存后刷新 | spec 用 `pg` 直接查 `model_alias` / `provider_model` | 证明写入的是模型 ID，不是只改了前端状态 |

## 副作用

无持久副作用：测试数据只落在 `_test` 库，并由 `afterAll` 清理。

- 测试在 `_test` 库创建提供商、模型、槽位和费率，`afterAll` 的 `emptyModelConfig` 会删除别名、模型与关联费率。验证后当前库状态：

```text
$ node --env-file=.env -e "..."   # select count(*) FROM model_alias / provider_model / credit_rate_card
model_alias 0 provider_model 0 credit_rate_card 2
```

- 剩余 2 条 `credit_rate_card` 是迁移 `008` 的初始历史费率，不是本轮界面创建的数据。
- 没有写产品库、没有调用真实模型、没有发送外部网络请求（候选请求只打到测试内本机 HTTP 服务）。

## 没覆盖的地方

- 真实上游模型的推理/工具/视觉能力；本 spec 只验证配置与界面，模型调用由夹具与 integration 覆盖。
- 键盘全路径与读屏器；只验证了 antd 控件的可访问名称与 480 宽布局不溢出。
- 生产库上的回填与切换；见 P6 迁移演练与计划说明。
- 两家提供商的同名模型由 SQL 预置，不是两次完整的界面登记流程；界面登记单条模型的流程由第 6–7 步覆盖。

## 你可以自己复核

1. 打开 [same-name-two-providers.png](artifacts/26-11-02/provider-model/same-name-two-providers.png)：模型表应有两条 `test-codegen-model`，提供商列分别是 `env-default` 与 `env-secondary`；槽位卡片显示第二提供商。
2. 打开 [slot-model-readonly.png](artifacts/26-11-02/provider-model/slot-model-readonly.png)：槽位弹窗应有「能力与兼容声明由提供商模型决定」提示，能力以标签展示，不应出现能力/回传开关。
3. 打开 [upstream-candidates.png](artifacts/26-11-02/provider-model/upstream-candidates.png)：上游候选区应有两个候选，已登记项带「已登记」标记；页面还保留本地的 `test-codegen-model`。
4. 对照 [model-manage.spec.ts:267](../../../../../tests/e2e/model-manage.spec.ts) 与 [model-manage.spec.ts:282](../../../../../tests/e2e/model-manage.spec.ts)：前者数行，后者查数据库身份。
5. 重跑：`bash .pi/skills/verify-paimeng-agent/run-proof.sh tests/e2e/model-manage.spec.ts`。
