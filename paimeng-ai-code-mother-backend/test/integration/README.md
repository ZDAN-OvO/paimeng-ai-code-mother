# PostgreSQL / Redis 集成测试

从仓库根目录使用标准安全入口。runner 构建后端，新建一次性 PostgreSQL 和 Redis，在空库上迁移两次，运行测试后销毁资源。测试直接导入 `../../dist/` 的生产服务，保留 Nest 注入元数据，不启动 HTTP 服务。

仅使用 runner 新建的一次性 PostgreSQL / Redis。runner 必须提供：

- `CI_TEST_ISOLATED=1`
- `CI_TEST_DATABASE_URL`：`postgres://...@127.0.0.1:<port>/paimeng_ci_<hex>`，也允许 `localhost`。
- `CI_TEST_REDIS_URL`：`redis://127.0.0.1:<port>/15`，也允许 `localhost`。
- `CI_TEST_WORK_DIR`：runner 创建的绝对路径、无符号链接、权限 0700 的临时私有目录。

连接 URL 不允许查询参数或片段，防止覆盖实际连接目标。没有默认连接，不读取 `.env`，不读取生产连接变量。测试用例自行创建用户、应用和消息，仅清理这些用户的级联数据及对应应用的 Redis key / registry member；不执行 flush、truncate、全库清理或全局队列恢复。runner 最终销毁容器、数据库和临时目录。

```bash
pnpm test:integration
# 同时运行集成测试与系统端到端测试时使用：
pnpm test:system
```

`scripts/ci/services.mjs` 复用 Drizzle migrator 和仓库原始 SQL。URL 校验在测试连接前执行。PostgreSQL 语句、锁等待及闲置事务均有服务端超时。测试有用例超时、等待上限与 finally 清理。并发通过受控 Agent 信号、真实 GET 响应屏障或 `pg_blocking_pids()` 同步，不用固定 sleep 判断结果。

覆盖：

- 空库迁移后的完整账本哈希、生产 schema 全表列集合、非空与默认值、索引有效性/唯一性/部分条件，以及外键删除策略。
- PostgreSQL 并发唯一约束：同应用 running / cancelling 排他；同应用同请求 ID 的终态记录也不能重复，且必须有一个真实提交成功的赢家。
- 公开 `RunsService.startRun()` 并发同请求：恰好一条 running run、两条消息、一条 session，重复内容幂等、冲突内容 409、终态后复用。
- `maxRunsPerUser=2`：两个公开请求必须真正进入 running；第三应用在生产派发方法 `startQueuedRun()` 收到上限 409且无残留写入；完成一个后第三应用能够启动。直接调用派发方法是因为公开 `startRun()` 对上限的行为是继续排队等待，并不直接返回该 409。
- 运行创建事务最后阶段的 PostgreSQL 整数溢出，必须撤销先前的 run / messages 写入；SessionStore 插话事务冲突后无残留，再次并发消费同 ID 仅写一次。
- 真实 run 行锁等待、提交取消后的终态选择、两个独立 RunsService 实例竞争收尾只写一个终态和一条活动；真实 cancelRun 的 DB / Redis 收尾与已消费/未消费插话区分。
- MessageQueueStore 真 Redis / Lua：强制 CAS 冲突与重试、同 ID 幂等、不同 ID 无丢失、不同内容/模式 409、cancel、pause/resume、三种终态、旧信号不干扰新 run、关闭插话与入队竞争。

未覆盖：模型与 Docker 执行、HTTP/SSE 网络、跨 PostgreSQL/Redis 崩溃恢复、全局启动恢复、真实故障注入、生产规模性能。用户上限拒绝通过内部派发入口观察，未验证公开队列在容量释放后自动重试的定时器。迁移空库重放和二次执行由 runner 完成，测试本身不更改 schema。
