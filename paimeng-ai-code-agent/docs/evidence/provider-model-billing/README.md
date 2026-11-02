# 提供商模型、槽位与费率：功能证据

日期：2026-11-02。分支：`agent/provider-model-p6`（堆叠在 #122 → #126 → #128 → #129 → #130 → #131 → #132 之上）。

## 环境

- 隔离 E2E 启动器：`npm run test:e2e:isolated`，生产构建，应用 `127.0.0.1:3000`、预览 `127.0.0.1:3001`，强制 `_test` Postgres 与夹具 harness。
- 管理端数据来自 E2E 夹具：两家提供商 `env-default` / `env-secondary`，请求名都为 `test-codegen-model`；模型、槽位和费率由测试直接准备。
- 截图分辨率 1280 宽；窄屏图 480 宽。
- 截图只证明界面与 PostgreSQL 中的真实读写，不证明上游模型质量或真实生产计费；这些由 integration 与后续切换演练负责。

## 结论与截图

| 结论 | 截图 | 断言来源 |
| --- | --- | --- |
| 同一请求名在两家提供商下是两条模型身份，槽位可按提供商选择 | [same-name-two-providers.png](images/same-name-two-providers.png) | `tests/e2e/model-manage.spec.ts`「同一请求名在两家提供商下是两条身份」；写后查 `model_alias.provider_id = env-secondary` 与 `provider_model_id` |
| 上游候选只用于发现：显示已登记/未登记，获取失败不清本地模型 | [upstream-candidates.png](images/upstream-candidates.png) | 同上文件「从上游候选登记模型并分配给槽位」「连通性检测与获取模型在界面上给出反馈」 |
| 槽位只选已登记模型；能力/兼容只读，缺价提示但不阻止分配 | [slot-model-readonly.png](images/slot-model-readonly.png) | 同上文件「能力与回传思考内容属于提供商模型」 |
| 费率按模型追加；历史未关联行保留并标记 | [rate-card-legacy.png](images/rate-card-legacy.png) | `tests/e2e/billing-rate-card.spec.ts`；行内断言「历史费率，未关联模型」 |
| 改价只追加版本，旧版本仍在且不再是现行 | [rate-card-versions.png](images/rate-card-versions.png) | 同上；两个生效时间的行与「现行」标签 |
| 480 宽页面可操作且页面本身不横向溢出 | [narrow-480.png](images/narrow-480.png) | `document.documentElement.scrollWidth - innerWidth <= 1`，表格在自身容器内横向滚动 |

## 运行记录

```text
$ npm run type-check
✓ Types generated successfully

$ npm test
Test Files  52 passed (52)
     Tests  508 passed (508)

$ npx vitest run --project integration
Test Files  60 passed | 1 skipped (61)
     Tests  495 passed | 1 skipped (496)

$ npm run check:fast
UI 写法检查通过（34 个 tsx）
E2E 写法检查通过（25 个 spec）
项目目录外的未提交改动与基线一致

$ npm run test:e2e:isolated -- tests/e2e/model-manage.spec.ts tests/e2e/billing-rate-card.spec.ts
13 passed (31.5s)
```

## 迁移演练

[`migration-rehearsal.txt`](migration-rehearsal.txt) 记录了一次临时 Postgres 容器上的从零迁移：

- `001` → `023_provider_model.sql` 全部执行成功（含额度管理的 019–022）；
- 回填工具 dry-run 读取新库，报告 0 个模型/槽位/步骤、2 条 `env-default` 孤立费率，零写入。
- 临时容器已删除；没有触碰开发库或共享测试库。

## 尚未证明 / 限制

- 没有在真实生产库上执行 `--apply` 回填；本机演练只验证了空库迁移与 dry-run。
- 没有真实上游的推理/工具调用/视觉能力验证；E2E 使用受控夹具与 `_test` 数据。
- 截图中的历史费率行来自测试预置，不是生产历史数据。
- 480 宽只验证了页面不溢出与主要区域可见；完整键盘/读屏路径仍由现有 antd 控件与单测覆盖。
- 计划归档与一次性回填工具删除要等完整 PR 链合入并在目标环境完成切换后再做。
