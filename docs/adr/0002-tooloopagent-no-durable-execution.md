# 0002 用 ToolLoopAgent，不做持久化执行

日期：2026-11-06
状态：已接受

## 背景

旧的生成引擎依赖 pi-durable 的 workflow 与 step 语义，模型实例甚至不能跨 step 边界。Workflow DevKit 能提供重启续跑，但也是上一轮返工的主要来源。

## 选项

1. `ToolLoopAgent`，单进程循环，消息每步落库。
2. `streamText` 加自写循环。
3. `WorkflowAgent` 加 Workflow DevKit。

## 结论

选 1。中断即失败，用户重试；已写入沙箱的文件保留。

## 后果

- 进程崩溃会丢失当前这一轮，需要一次重试。
- 消息与工具结果必须逐步持久化，重试后对话仍然完整。
- 以后要续跑，可在此之上加检查点，不需要换引擎。
