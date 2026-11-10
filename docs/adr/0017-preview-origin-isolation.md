# 0017 预览按 Chat 使用独立浏览器来源

日期：2026-11-10
状态：已接受；细化 [ADR 0008](0008-preview-dev-server-proxy.md) 的来源边界，保留 dev server 加反代的结论

生成页面的 JavaScript 在用户浏览器中执行，Docker 无法限制它访问同源工作台。本地实验中，同源 iframe 可以读取父页面；去掉 iframe 的同源权限后，Next.js 水合、请求与热更新又失败。

选择工作台与 Preview 使用不同来源，每个 Chat 分配独立 hostname，并结合 iframe 权限、代理来源检查与 CSP。保留 `/preview/<chatId>` 路径作为路由，路径本身不承担隔离职责。这样可以保留 Next.js 交互与 HMR，并让浏览器阻止预览读取工作台与其他 Chat。代价是增加域名映射、来源配置和代理管理。

本地 `*.localhost` 已有可行性观测；远程访问、HTTPS、cookie 与写接口保护尚需验收。Template 的开发来源配置由产品管理，不依赖框架默认信任 localhost。独立来源不等于请求鉴权，iframe 与 CSP 也不能替代工作台服务端的来源与权限校验。

此决定覆盖 Preview；原 `/deploys/<deployKey>` 发布地址仍保留，其同源浏览器风险与兼容方式在 M5 开工前评审，不将 Preview 的实验结果外推成发布已经隔离。当前设计见[架构第 8 节](../architecture.md#8-沙箱与预览)。
