# 后端规范（NestJS）

## 结构

- 按领域分目录：`auth`、`apps`、`conversations`、`runs`、`agent`、`tools`、`skills`、`runtime`、`preview`、`config`、`db`、`redis`、`startup`。
- 控制器只做参数校验、取当前用户、调用 service；Agent 工具循环、Docker 调度、文件操作放在对应 service 中。
- 新的 provider/controller 需要在 `src/app.module.ts` 注册。

## 接口

- 请求体用 zod schema + `createZodDto`（nestjs-zod），schema 写在控制器或 `dto.ts`，字段边界（长度、范围、枚举）写全。
- 控制器直接返回数据，由 `EnvelopeInterceptor` 包装成 `{ code: 0, message: 'ok', data }`。SSE、预览代理等非 JSON 响应使用 `@RawResponse()`。
- 业务错误抛 `ApiException` 的静态工厂（`badRequest`、`notFound`、`conflict` 等），`message` 写给最终用户看的中文原因，不要直接抛 Nest 内置 `HttpException`。
- 当前用户通过 `@CurrentUser()` 获取，不要从请求体信任 userId。
- 用户、应用使用数值 ID；运行使用 UUID；时间输出 UTC ISO 字符串。

## 配置

- 环境变量在 `src/config/env.ts` 的 zod schema 中声明，业务代码通过 `AppConfigService` 读取，新代码不要直接读 `process.env`。已有例外：`src/db/migrate.ts`（独立脚本）和 `src/runtime/docker.service.ts`。
- 新变量要有合理默认值或明确标记为必填，并同步根目录 `.env.example`。

## 数据库

- 表结构只改 `src/db/schema.ts`，然后运行 `pnpm db:generate` 生成新迁移，再用 `pnpm db:migrate` 应用。
- 不要修改或删除 `drizzle/` 下已有的迁移文件和 `meta/`。
- 并发约束（同一应用单 run、用户并发上限）依赖数据库唯一索引和行锁，不要改成进程内计数或只靠 Redis。

## 运行时与 Agent

- `runtime/` 是生成应用的源码、依赖和日志目录，已被忽略。不要提交其中内容，测试也不要依赖其中的现有数据。
- 文件工具必须经过 `runtime/file-service.ts` 的路径、大小和数量校验；依赖安装必须经过 `dependency-policy.ts` 白名单。
- 外部进程（Docker CLI、模型调用）都要有超时和取消处理，参考 `runtime-timeouts`、`cancellation` 相关测试。
- 生成技能放在 `.paimeng/skills/<name>/SKILL.md`，目录名与 frontmatter 的 `name` 一致，必须有 `name` 和 `description`。

## 测试与风格

- 单元测试用 Vitest，文件放在 `test/*.spec.ts`。修 bug 时先写能复现问题的测试；涉及 Docker 时使用可控替身，不依赖真实容器。
- Prettier：无分号、单引号、行宽 110、尾逗号。提交前运行 `pnpm format:check`。
- `pnpm dev` 会先完整构建再启动，没有热重载；需要监听时另开 `pnpm dev:watch`。
