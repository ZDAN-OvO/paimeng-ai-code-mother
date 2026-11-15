# Agent 使用 AI SDK 和普通 TS 编排，只用 Responses 接口

Agent 的模型调用和工具循环交给 Vercel AI SDK，生成、验证、修复这一外层流程用普通 TypeScript 编排，模型只通过 OpenAI Responses 兼容接口调用，并关闭 SDK 的隐式重试。外层流程需要逐步控制持久化、取消、预算和收尾，图式编排框架会把这些控制点藏进框架内部；Responses 接口是目标网关验证过工具往返的协议。网关不支持时直接报告阻塞，不静默切换到 Chat Completions 或其他框架。

## Considered Options

- LangChain / LangGraph：编排能力更多，但持久化和取消语义要迁就框架的检查点模型。
- 直接调用 HTTP：控制最细，但要自行处理流式解析、工具调用拼装和类型。
