# 0008 预览：dev server 加反向代理

日期：2026-11-06
状态：已接受

## 背景

多轮迭代的体验核心是保存即可见。每次改动都等待构建会毁掉这个节奏。

## 选项

1. 每轮 `next build` 后启动。
2. 沙箱内常驻 `next dev`，宿主机反代。
3. 静态托管预览。

## 结论

选 2。容器内 `next dev`，宿主机按 Chat 把 `/preview/<chatId>` 反代到容器端口，同时代理 HMR WebSocket。

## 后果

- 需要处理子路径、绝对资源路径与 WebSocket，先用 spike 验证。
- 预览容器与生成容器是同一个，文件工具写入即触发 HMR。
- 生产发布走独立流程，不复用 dev server。

## 2026-11-10 验证说明

保留 dev server 加反代的选择。本地 spike 已用最小 Next.js 项目验证页面、API 与 HMR，禁网加 socket 中继、internal bridge 加宿主直连两种连接方式均有可行性观测；传输方式仍受宿主隔离验证约束，不能把二者同时当成已选默认。

浏览器来源边界由 [ADR 0017](0017-preview-origin-isolation.md) 细化；`/preview/<chatId>` 保留为路由，使用独立预览 hostname。代理需有 WebSocket upgrade 入口，Template 的开发来源配置需随部署计算。产品接入、非本机来源与稳健性尚未验收，当前结构见[架构第 8 节](../architecture.md#8-沙箱与预览)。
