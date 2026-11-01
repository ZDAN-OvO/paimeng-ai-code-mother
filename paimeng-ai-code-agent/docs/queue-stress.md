# 队列与消息流压测

这是现有实现的基线测量入口，不替换队列、不修复产品行为。结果用于判断任务积压、流式传输和内存占用之间的关系。

## 运行

在 `paimeng-ai-code-agent/` 下：

```bash
npm run stress:queues
npm run stress:sandbox-queue
```

两条命令顺序运行，不与 integration、system、E2E 或其他压测并发。第二条依赖 `prototype:sandbox` 已准备的 React 依赖缓存和本地 `node:24-alpine`；不会自动下载镜像或安装依赖。

需要现有 Postgres、Redis 和 Node 24。读取本地 `.env` 获取连接参数，产品库强制映射到 `paimeng_app_test`、Harness 库映射到 `paimeng_agent_test`、Redis 使用 DB15。检测到 Harness 测试库已有其他连接时拒绝启动。

不重置数据库、不清空 Redis、不修改模型配置。创建唯一前缀测试账号和独立 App，测试数据保留在测试库，便于复核。产物保存在 Git 忽略的 `runtime/queue-stress/<runId>/`。日志不记录登录 Cookie、账号密码或模型密钥。

## 正式生成链路的基线

`stress:queues` 会构建到独立 `.next/queue-stress/`，启动独立端口的生产模式 Next 和真实 Harness。模型上游由同进程内的本地 OpenAI-compatible SSE 服务替代，真实的模型适配、Generation 准入、输入账本、SDK submission、Transcript、SSE 和客户端断连路径仍然运行。HTML 模板避免混入 Docker 构建负载。

负载：

- 单个 Generation，64 KiB 文本。
- 12 个 Generation 同时提交，以及 12 个请求等待前一个准入完成后再提交；全局活跃上限保持 4。
- 同一活跃 Generation 下分别积压 100、1000 条输入，每条 1000 字符，请求并发 8。
- 8 个正常读取的 Harness SSE 订阅、8 个暂停读取的订阅、32 个暂停读取的订阅；每次输出 256 KiB 文本。
- 生成的浏览器连接中途断开，检查 Generation 终态和可恢复消息。
- 4 条真正的生成响应暂停读取，每条合成 1 MiB 文本，用于探测消息流积压。此项明确超过模型声明的单次输出预算，属于异常上游负载，不能当作正常用户负载。

可用 `STRESS_SCENARIOS=generation-clients-paused` 只运行指定前缀场景；用逗号分隔多个前缀。已有本脚本构建产物时可设置 `STRESS_REUSE_BUILD=1` 跳过重复构建；产品代码或构建配置改变后应重新构建。

输入积压场景暂缓模型输出，记录完持久输入后取消测试 Generation，避免自动消费 1000 轮后续输入。该场景测量入队、持久化和取消，不证明全部输入已被成功消费。

“暂停读取”使用 Node HTTP response 的 `pause()`，用于触发 TCP 慢消费者；客户端不把响应体无限累积进测量进程。订阅地址是 Harness `/events`，与业务生成响应分开，不能据此直接断言 `ChunkChannel` 内存分配来源。

每 500ms 通过仅绑定回环地址的 Node Inspector 读取 Next / Harness 的 RSS、堆内存、事件循环累计数据和可见活动观察者数量，同时读取宿主机 MemAvailable、测试账号活动 Generation 数和本地模型实际并发。通过 Inspector 临时包装 HTTP `write()`，仅统计发送字节、返回 false 的次数和 `writableLength` 峰值；不改变原返回值和背压行为，也不记录消息正文。观测补丁只存在于本次服务进程内存，退出即消失。

各场景结束等待 6 秒观察自然回落，再显式执行一次 GC，记录仍可达的堆占用。RSS 不回落不等同于内存泄漏；GC 后堆占用也需要结合仍保留的会话与缓存解释。

单个服务 RSS 达到 900 MiB 或宿主机 MemAvailable 小于 2 GiB 时停止施压；服务堆上限为 768 MiB。停止阈值用于保护开发机器，不代表生产容量建议。报告记录 `safetyStops`，触发阈值的场景应按容量失败分析，不能因为没有整机 OOM 就算通过。

## Docker 原型队列

`stress:sandbox-queue` 读取当前 `sandbox.prototype/run.mjs` 中的真实队列实现，记录源文件 SHA-256 后放入独立测量进程。只调整临时路径、控制台输出和占位任务的持续时间，不替换 enqueue / Promise 链或请求记录逻辑。

一个真实 Docker 容器占用执行槽位，分别排入 100、1000、10000 个轻量任务描述。测量进程 GC 后堆内存、RSS、实际等待数和累计记录数。测量后取消全部等待任务，不执行 10000 次构建；等待占位容器停止，再检查最大并发和容器遗留。

原型会保存所有结果与事件，因此分别测量“任务取消但报告仍保留”和“释放报告及任务句柄”两种状态。前者的堆占用不能直接当作 Promise 队列泄漏。

这项结果只描述原型，不代表正式平台已经有 Docker 排队入口，也不验证跨进程调度或持久恢复。

## 读报告

- `report.json`：原始配置、场景结果、状态分布、输入持久化计数、延迟与内存时间序列。
- `next.log`、`harness.log`、`build.log`：本次拥有的服务日志。
- 每次运行使用不同目录和测试数据前缀，便于对比。

优先核对生成终态、接受／拒绝请求数、持久化条数和安全阈值，再解释峰值内存。HTTP 返回成功、进程未崩溃或脚本正常退出，都不能单独证明没有积压风险。
