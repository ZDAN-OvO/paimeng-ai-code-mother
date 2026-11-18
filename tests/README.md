# 按模块验证

日常开发运行改动模块对应的测试。全量离线与系统回归用于整批收尾或合并前；CI 仍运行完整门禁。

```bash
pnpm test:module backend file-service
pnpm test:module frontend queued-chat-enqueue
pnpm test:module ci services
pnpm test:module integration redis
pnpm verify run cancellation
```

每个 scope 的可选名称用 `pnpm test:module <scope> --list` 查看，传文件名主干，不带路径或扩展名。后端、前端和 CI 支持一次指定多个名称；集成模块每次选一个。漏写或拼错名称会失败，不会回退运行全套。

| 改动边界 | 验证入口 |
| --- | --- |
| 后端独立逻辑 | `test:module backend <名称>`，Vitest 离线 |
| 前端独立逻辑 | `test:module frontend <名称>`，node:test |
| 启动器进程管理 | `test:module ci services`；取证逻辑用 `test:module ci verify-evidence`，再按根规范执行取消检查 |
| PostgreSQL 持久化、约束或事务 | `test:module integration postgres`，真实一次性服务 |
| Redis 队列、Lua 或过期规则 | `test:module integration redis`，真实一次性服务 |
| 页面、SSE、静态预览的用户路径 | `verify run <功能>`，见[验证技能](../.agents/skills/verify-paimeng/SKILL.md) |
| 整批收尾 | `pnpm test`、`pnpm test:system` 和根规范中的其他门禁 |

前端排队测试按职责选择：`queued-chat-utils` 是输入与状态推导，`queued-chat-coordinator` 是订阅与停止，`queued-chat-enqueue` 是入队幂等，`queued-chat-recovery` 是请求恢复，`app-chat-page-queue` 是页面装配的源码契约。最后一组会抽取页面动作，不能替代浏览器验证；在有等价的真实页面覆盖前保留这些回归断言。

后端取消测试按文件工具、容器阶段、SSE 连接分别放在 `file-tool-cancellation`、`runtime-cancellation`、`runs-controller-sse`，不再用一个文件覆盖三层职责。临时目录由 `test/support/temp-dir.ts` 按当前用例统一清理，不删除其他测试或用户的目录。
