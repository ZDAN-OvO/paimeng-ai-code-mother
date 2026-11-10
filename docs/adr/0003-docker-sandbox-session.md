# 0003 沙箱实现 SDK 的 SandboxSession 接口

日期：2026-11-06
状态：已接受

## 背景

AI SDK 7 自带 `SandboxSession` 类型（读文件、写文件、list、stat、delete、run、spawn），工具执行上下文里带 `experimental_sandbox`。旧库已有经过验证的 Docker 构建隔离参数。

## 选项

1. 自造沙箱接口。
2. 实现 SDK 的 `SandboxSession`，后端用本地 Docker。
3. 用 Vercel Sandbox 或 E2B。

## 结论

选 2。默认后端是 Docker；接口一致，后接云沙箱只是换实现。

## 后果

- 沙箱容器每 Chat 一个，工作区为命名卷。
- 默认禁出站，安装依赖时按域名临时放行。
- `experimental_sandbox` 的确切接入点要先用 spike 确认。

## 2026-11-10 验证说明

保留上述选择。AI SDK 7.0.166 接受每次 agent 调用传入的 `experimental_sandbox`，工具从执行上下文取得该对象。接口实际有 `description` 和 11 个方法，共 12 个成员；先前只列读写等方法类别，不代表完整接口清单。

本地原型通过类型检查与 19 项已列行为用例，说明继续实现 SDK 接口可行；其中仍有类型断言、空文件流与取消清理缺口，不能据此声称完整符合接口语义。SDK 允许绝对路径，Workspace 范围与修订校验需由产品另行约束。正式设计与验收边界见[架构第 8 节](../architecture.md#8-沙箱与预览)，网络策略进一步见 [ADR 0016](0016-controlled-sandbox-egress.md)。
