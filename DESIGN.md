# Paimeng 的生成、交付与对话历史

Paimeng 把应用权限和作品交付放在 Java，把对话历史、类型路由和生成放在 Python。浏览器只访问 Java。服务间请求使用 `X-Internal-Token`，Python 默认监听本机地址。

## 服务与数据归属

| 目录 | 职责 | 数据 |
| --- | --- | --- |
| `paimeng-backend/` | 登录、应用权限、任务编排、预览、下载和发布 | Java PostgreSQL 保存用户、应用和生成任务。Redis db 0 保存登录会话并供缓存与限流使用 |
| `paimeng-agent-service/` | 类型路由、应用对话历史、代码生成和 Vue 构建修复 | Python PostgreSQL 保存完整可见历史。Redis db 1 缓存带版本的 Agent 上下文 |
| `paimeng-frontend/` | 提交任务、订阅输出和展示交付后的预览 | 浏览器沿用登录 Cookie |
| `sql/pg/` | 两个独立 PostgreSQL 数据库的表结构、旧数据迁移和本地依赖配置 | 迁移脚本保留原 ID、归属和历史顺序 |

Java 与 Python 分别使用独立的 PostgreSQL 账号。Python 在同一事务内写消息并递增会话版本。更新 Redis 时校验旧版本。Redis 不可用或版本不符时，Python 从 PostgreSQL 的一致快照读取上下文。消息查询按照创建时间和 ID 倒序翻页，历史接口以字符串传输 ID，以秒精度传输上海本地时间。

## 提交、回放与交付

1. 浏览器向 `POST /api/app/chat/tasks` 提交消息和 `clientRequestId`。同一应用重复提交同一个请求 ID 时返回原任务。另一条指令撞上运行中的任务时，返回当前任务供页面续接。
2. Java 从正式目录复制出本轮临时目录，调用 Python 生成。Python 通过 OpenAI Responses 读正文和函数调用，Vue 项目在受限 Docker 容器中构建。构建失败后把关键错误交给模型，最多自动修复两次。
3. Java 将任务事件写入 Redis db 2。页面通过 `GET /api/app/chat/tasks/{taskId}/events` 按 SSE ID 回放和追踪。断线重连时使用 `Last-Event-ID` 或 `lastEventId`。流过期时，页面重新请求对话历史。
4. Java 在 `COMMITTING` 阶段持久化候选结果和目录交换进度。Java 完成交付后按任务 ID 提交 Python 历史，再写成功终态。生成或交付失败时，Java 保留或恢复原正式目录，提交失败历史。
5. 应用重启时按持久进度恢复。运行阶段由 Redis 租约限制旧执行者写流。交付阶段由 PostgreSQL 持久化状态和应用级锁保证同一个任务完成交换及历史提交。

浏览器可通过 `GET /api/app/chat/tasks/active` 找回运行中任务或最近的终态。公开流包含 `message`、`status`、`done` 和 `business-error`。成功和失败各有一条终态。

## 工作区与本地模型

Java 与 Python 共用 `PAIMENG_WORKSPACE_ROOT`。同一应用的正式目录为 `code_output/{codeGenType}_{appId}`，本轮临时目录为 `code_staging/{codeGenType}_{appId}/{taskId}`。部署目录为 `code_deploy/{deployKey}`。Java 在交付后为预览、下载和部署读正式产物。

Python 通过 `MODEL_BASE_URL`、`MODEL_NAME` 和 `MODEL_API_KEY` 配置 Responses 网关。通过 Windows 本机 Magpie 验收时，使用 `http://127.0.0.1:3425/v1` 和 `auto/deepseek-v4.1-flash`。密钥由本地环境提供。构建容器单独挂载临时目录，模型和数据库凭据留在服务进程。

## 数据迁移顺序

先在 Java PG 执行 `01_init_java_db.sql`，再从旧 MySQL 导入用户、应用和历史。应用切换到 Python 历史前，在独立的 Python PG 依次执行 `02_init_python_history_db.sql` 和 `04_python_generation_history.sql`。Java PG 执行 `03_generation_task.sql` 后存储新任务和待处理的历史清理请求。

迁移前停止源库写入，并等待在途任务结束。用 `migrate_mysql_to_pg_java.py` 和 `migrate_java_pg_to_python_history.py` 分别完成两次迁移。脚本核对历史内容、主键和归属。确认目标库记录以及已发布项目的目录后，再打开写入。

### 停写与排空

所有 Java 实例共用 `TASK_REDIS_URL` 和 `WRITE_BARRIER_NAMESPACE`。第一次启动新环境时，执行 `uv run --script sql/pg/write_barrier.py init` 初始化写入准入。登记状态丢失时，Java 会拒绝新写入，待操作者核对后恢复。

在 Java PG 阶段，执行 `uv run --script sql/pg/write_barrier.py pause` 取得批次号。把 `WRITE_BARRIER_PG_DSN` 指向源 Java PG，执行 `uv run --script sql/pg/write_barrier.py await <批次号> --timeout 120`。工具等在途写入结算，并核对未交付任务及待清理的历史。状态为 `java_drained` 后，仍要停掉独立的 Python 写入方并排空在途请求。核对迁移结果后，用 `resume <批次号>` 恢复写入。未处理的后台失败会阻止排空。处理后，用 `resolve-failed` 记录登记号和核对证据。

MySQL 阶段使用旧版 Java 的运行和数据库记录，独立确认旧代码生成、截图回写和历史清理均已结束。将 MySQL 的停写时点与 Java PG 切换前的停写时点分别记录。

服务职责、历史缓存、任务回放和目录交付的取舍记录在 [架构决策](docs/adr/) 中。术语见 [项目术语](GLOSSARY.md)。
