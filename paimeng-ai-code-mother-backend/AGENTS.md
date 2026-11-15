# 后端规范（NestJS）

## 结构

```text
paimeng-ai-code-mother-backend/
├── src/
│   ├── main.ts / app.module.ts   # 启动入口与模块注册
│   ├── config/                   # 环境变量 schema 与 AppConfigService
│   ├── common/                   # 统一包络、错误码、HTTP 工具、截断
│   ├── db/                       # Drizzle schema 与迁移脚本
│   ├── redis/                    # Redis 连接
│   ├── startup/                  # 单实例锁与启动收尾
│   ├── health/                   # 存活与就绪检查
│   ├── auth/                     # 注册、登录、session
│   ├── apps/                     # 应用 CRUD 与删除流程
│   ├── conversations/            # 对话、消息与 UIMessage 转换
│   ├── runs/                     # 运行的创建、流式输出、取消、详情
│   ├── agent/                    # 模型调用、上下文预算、系统提示
│   ├── tools/                    # 提供给模型的工具注册与包装
│   ├── skills/                   # 技能注册与读取
│   ├── runtime/                  # 文件服务、依赖策略、Docker 调度
│   └── preview/                  # 预览授权与预览网关
├── .paimeng/skills/              # 生成技能：static、vue、react
├── drizzle/                      # 已生成的迁移文件，不要修改
├── scripts/                      # 黑盒验收与维护脚本
├── test/                         # Vitest 单元测试（*.spec.ts）
└── runtime/                      # 生成应用的源码、依赖和日志，已忽略
```

- 控制器只做参数校验、取当前用户、调用 service；Agent 工具循环、Docker 调度、文件操作放在对应 service 中。
- 新的 provider/controller 需要在 `src/app.module.ts` 注册（现状见下文“模块”）。

## 框架规范（NestJS 11）

以官方文档为准。项目锁定 NestJS 11，`docs.nestjs.com` 现在是 v12 文档，v11 以 GitHub `nestjs/docs.nestjs.com` 的 `11.0.0` 分支为准；两者不一致时按 v11。

### 模块

- 官方推荐按业务领域拆 feature module，模块只 `exports` 需要被其他模块使用的 provider（Modules 章节）。现状是业务 provider 全部注册在 `AppModule`，只有 `config`、`db`、`redis` 是独立模块。
- 不要在现状上局部新建只包含部分业务 provider 的 feature module：它看不到注册在根模块里的 service，补救时容易产生循环导入。拆分模块需要整体迁移，并按 `docs/DESIGN.md` 第 3 节的分层确定 `exports`。
- 不使用 barrel 文件（`index.ts` 汇总导出）组织 module 和 provider，官方明确指出它会造成循环依赖（Circular dependency 章节）。
- 避免循环依赖，不用 `forwardRef` 掩盖分层问题；需要时把共享部分下沉到更低层的模块。

### 请求管线

各类组件按官方职责使用，不要混用：

| 组件 | 用途 | 本项目 |
|---|---|---|
| Guard | 是否允许处理请求 | `AuthGuard`、`OriginGuard`（全局） |
| Pipe | 参数转换与校验 | `ZodValidationPipe`（全局） |
| Interceptor | 响应映射 | `EnvelopeInterceptor`（全局） |
| Exception filter | 异常转响应 | `GlobalExceptionFilter`（全局） |
| 自定义参数装饰器 | 从请求中取值 | `@CurrentUser()` |

- 鉴权逻辑放 Guard，不要写进 service 或 Interceptor。
- 只有流式响应、预览代理和就绪检查可以使用 `@Res()`。官方说明使用 `@Res()` 后，Interceptor 的响应映射不再生效，所以其他接口直接返回数据。
- 全局组件通过 `APP_GUARD` / `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` 注册，以便参与依赖注入；不要改用 `app.useGlobal*()`。

### 配置与生命周期

- 环境变量在启动时整体校验，缺失或非法立即失败，这是官方推荐做法（Configuration 章节）。本项目用 zod 实现，没有引入 `@nestjs/config`，不要再引入第二套配置机制。
- 持有连接、子进程、定时器或服务器的 provider 必须在 `onModuleDestroy` 或 `beforeApplicationShutdown` 中释放；`main.ts` 已调用 `enableShutdownHooks()`，不要移除。
- 启动前必须完成的检查放在 `onModuleInit` / `onApplicationBootstrap`，不要放在构造函数里做 I/O。

## 接口

- 请求体用 zod schema + `createZodDto`（nestjs-zod），schema 写在控制器或 `dto.ts`，字段边界（长度、范围、枚举）写全。
- 新接口的查询参数和路径参数同样定义成 zod DTO，用 `@Query() dto` 接收；不要新增 `@Query('id') raw: string` 再手动解析的写法。
- 控制器直接返回数据，由 `EnvelopeInterceptor` 包装成 `{ code: 0, message: 'ok', data }`。SSE、预览代理等非 JSON 响应使用 `@RawResponse()`。
- 每个 JSON 接口都要声明响应 schema：用 `envelope(数据 schema)` 生成 `BaseResponse*` DTO，挂在 `@ApiOkResponse` 上，并给控制器加 `@ApiTags`、给方法加 `@ApiOperation`。处理函数用 `z.output<typeof schema>` 标注返回类型，让返回值与 schema 对不上时编译失败。
- 改完 schema 运行 `pnpm openapi:export` 更新根目录 `openapi.json`（与前端生成代码一起提交）。`openapi.json` 是生成产物，不要手改；`pnpm openapi:check` 会检测是否过期。
- OpenAPI 中声明响应时，按官方“generic ApiResponse”的写法：用 `ApiExtraModels` 注册数据模型，用 `getSchemaPath` 加 `allOf` 把它放进包络的 `data` 字段（OpenAPI Operations 章节）。不要用 `nestjs-zod` 的 `ZodResponse`，它要求处理函数直接返回 schema 本身，和统一包络冲突。
- OpenAPI 页面在 `/api/v3/api-docs`，按 `@nestjs/swagger` 默认约定，JSON 在 `/api/v3/api-docs-json`。
- 业务错误抛 `ApiException` 的静态工厂（`badRequest`、`notFound`、`conflict` 等），`message` 写给最终用户看的中文原因，不要直接抛 Nest 内置 `HttpException`。
- 当前用户通过 `@CurrentUser()` 获取，不要从请求体信任 userId。
- 用户、应用使用数值 ID；运行使用 UUID；时间输出 UTC ISO 字符串。

## 配置

- 环境变量在 `src/config/env.ts` 的 zod schema 中声明，业务代码通过 `AppConfigService` 读取，新代码不要直接读 `process.env`。已有例外：`src/db/migrate.ts`（独立脚本）和 `src/runtime/docker.service.ts`。
- 新变量要有合理默认值或明确标记为必填，并同步根目录 `.env.example`。

## 数据库

- 表结构只改 `src/db/schema.ts`，然后运行 `pnpm db:generate` 生成新迁移，再用 `pnpm db:migrate` 应用。
- 不要修改或删除 `drizzle/` 下已有的迁移文件和 `meta/`。
- 不使用 `drizzle-kit push`。Drizzle 官方把 push 定位为快速原型，本项目以生成的 SQL 迁移为准，迁移要能在空库上重放。
- 需要原子性的多条写入放进同一个 `db.transaction(async (tx) => …)`，事务内只用 `tx`，不要混用外层 `db`。
- 并发约束（同一应用单 run、用户并发上限）依赖数据库唯一索引和行锁，不要改成进程内计数或只靠 Redis。

## 运行时与 Agent

- `runtime/` 是生成应用的源码、依赖和日志目录，已被忽略。不要提交其中内容，测试也不要依赖其中的现有数据。
- 文件工具必须经过 `runtime/file-service.ts` 的路径、大小和数量校验；依赖安装必须经过 `dependency-policy.ts` 白名单。
- 外部进程（Docker CLI、模型调用）都要有超时和取消处理，参考 `runtime-timeouts`、`cancellation` 相关测试。
- 模型调用保持 `maxRetries: 0`，这是有意的设计（ADR-0001）：自动重试会重复工具副作用并消耗运行预算。错误优先用 AI SDK 错误类型的 `isInstance()` 区分；只有网关没有提供结构化信息时（如当前的上下文超限判断）才匹配错误文本，并为该匹配写测试。
- 生成技能放在 `.paimeng/skills/<name>/SKILL.md`，目录名与 frontmatter 的 `name` 一致，必须有 `name` 和 `description`。

## 测试与风格

- 单元测试用 Vitest，文件放在 `test/*.spec.ts`。修 bug 时先写能复现问题的测试；涉及 Docker 时使用可控替身，不依赖真实容器。
- 需要依赖注入的测试，用 `@nestjs/testing` 的 `Test.createTestingModule()`，配合 `overrideProvider()` 替换外部依赖，不要手动 `new` 一整条依赖链（Testing 章节）。
- Prettier：无分号、单引号、行宽 110、尾逗号。提交前运行 `pnpm format:check`。
- `pnpm dev` 会先完整构建再启动，没有热重载；需要监听时另开 `pnpm dev:watch`。

## 版本升级

- NestJS 12 原生支持 Standard Schema：`@Body({ schema })`、`StandardSchemaValidationPipe`，Swagger 也能直接转换 zod 4。升级后 `nestjs-zod` 的大部分职责会被框架替代。
- 升级 NestJS 大版本涉及 ESM 和 Node 版本要求，属于架构决策，需要先写 ADR；不要在 v11 上混用两套校验方式。
