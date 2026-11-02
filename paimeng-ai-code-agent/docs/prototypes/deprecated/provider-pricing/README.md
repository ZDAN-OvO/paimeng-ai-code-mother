# Provider pricing prototype（历史原型）

归档日期：2026-11-02。采纳日期：2026-11-02；仅采纳「提供商下登记模型、模型内维护人民币单价、再分配槽位」的交互方向，实施基线为 `f7e6b36`（model config JSON storage），当前决策见 [ADR-0006](../../../adr/0006-model-config-document.md)。原型整体置于 `deprecated/`：其中的倍率、汇率及自动推导售价未被采纳，不能作为生产实现规范。

当前产品由 Admin **明确填写人民币 / 1M tokens 单价**，服务端存整数分；1 分 = 1 Credit。**没有倍率或汇率输入，也不从上游 USD 价格自动生成售价**。当前保存追加立即生效的价格版本，不能通过 Admin 回填过去或预约未来时间；原型里的自选生效时间也不是当前能力。

此目录保留原始 HTML/CSS/JS 作为历史交互证据，不继续修改其中的旧策略。本工作树原先未跟踪该原型，归档时从主工作树的 `docs/prototypes/in-progress/provider-pricing/` 导入；未删除主工作树文件。目录中的模型、单价、成本、日期和上游列表均为演示数据，未连接产品 PostgreSQL、真实计费或真实模型调用，不能作为迁移/结算验收证据。未发现本工作树中的 `model-config-json` 原型，未创建替代物。

从仓库根打开：

```bash
python3 -m http.server 8100 --directory paimeng-ai-code-agent/docs/prototypes/deprecated/provider-pricing
```

浏览 `http://127.0.0.1:8100/`。当前操作规范见[模型配置](../../../provider-convergence.md)与[计费运行说明](../../../billing-operations.md)。
