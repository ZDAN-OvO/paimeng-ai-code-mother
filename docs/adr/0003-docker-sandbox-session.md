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
