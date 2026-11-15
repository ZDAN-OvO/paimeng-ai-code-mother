# 接口类型以后端 zod 为唯一来源，前端用 openapi2ts 生成代码

后端所有 JSON 接口的请求、响应都写成 zod schema，由 `pnpm --filter paimeng-ai-code-mother-backend openapi:export` 离线导出 `openapi.json` 并提交进仓库；前端用 openapi2ts 从同一文件生成 `src/api/generated/`，普通接口不再手写请求函数和类型。流式聊天保留手写代码，因为 SSE 的 chunk 结构 OpenAPI 表达不了，但它引用的消息和类型仍来自生成结果。

选择离线导出而不是读取运行中的服务，是为了让生成和 `pnpm contract:check` 不依赖数据库、Redis 和 Docker。选择生成而不是共享契约包，是因为 workspace 结构不必变化，前端也不需要运行时校验；代价是类型只到编译期，跨端共享 zod 时需要再评估拆包。

## Consequences

- 改接口字段只改后端 schema，然后运行导出和生成；`contract:check` 在 CI 或本地发现过期产物。
- 生成的代码不能手改。编译不过时改 schema 或生成配置，不改生成结果。
- 导出的文档固定为 OpenAPI 3.1：可空字段用 `anyOf` 加 `{ "type": "null" }` 表达。openapi2ts 不识别 3.0 的 `nullable`，会让可空枚举退化成 `any`；`type: "null"` 在 3.0 里又不合法，因此导出时统一转成 3.1 的写法。
