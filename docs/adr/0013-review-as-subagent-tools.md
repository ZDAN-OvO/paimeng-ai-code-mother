# 0013 Review 做成 subagent 工具，由主 agent 决定何时调用

- 状态：已接受
- 日期：2026-11-09

## 背景

主 agent 用同一个模型、同一份上下文审自己的产出，容易判自己通过；上下文越长，检查时的注意力越弱。审查也需要能单独选模型、单独调优，并且让用户看到「被审了几次、为什么打回」。

可选做法：

1. 主 agent 自查：验证与完成判定都是普通工具，结果回到同一个模型。
2. 宿主固定流程：每轮结束后依次调用 code review agent 与 completion review agent。
3. 两个 review agent 包成工具，由主 agent 判断何时调用哪一个。

## 结论

选 3。code review agent 与 completion review agent 各是一个独立的 `ToolLoopAgent`，有自己的模型、指令与只读工具，经 `tool()` 暴露给主 agent（AI SDK subagent 写法）。小改动只跑 CI；大改动在 CI 之后调用 code review，可以多次、只覆盖局部；交付前才调用 completion review。review 只看产物、证据与本轮目标，不看主 agent 的推理过程。

## 后果

- 方案 2 让小改动也付两次审查的成本，且两种审查不是一对一，因此不采用；方案 1 是本决策要解决的问题，留作评测对照组。
- 主 agent 可能该审不审。宿主底线（ADR 0010）兜住确定性检查，漏审率作为评测指标，用来调主 agent 的判断提示词。
- 主 agent 与 review agent 用不同家族的模型，减少相同盲点；是否值得这份成本由评测对比决定。
- subagent 内的工具不能走审批流程，review agent 只给只读工具。
- 推翻 2026-11-07 架构里「不设检查 Agent」的结论。
