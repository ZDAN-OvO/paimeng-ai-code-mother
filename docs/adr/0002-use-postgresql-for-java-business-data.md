# Java 业务库迁到 PostgreSQL

Java 的业务数据从 MySQL 迁到 PostgreSQL，继续使用 MyBatis-Flex。Java 和 Python 共用一个 PostgreSQL 实例，各自使用独立的数据库和账号。这样开发环境只需要维护一种关系型数据库，同时由各服务管理自己的表。

先独立验证 Java 换库，再接入 Python Agent。已有用户和应用沿用原有 ID 和归属关系，验收覆盖旧账号登录、打开旧应用、创建和修改应用、分页搜索与删除。Java 换库时也迁移对话历史，过渡期继续由 Java 读写；正式切换时再按 [ADR 0001](0001-python-owns-app-chat-history.md) 从 Java PostgreSQL 迁入 Python，避免旧历史暂时不可见或遗漏过渡期新增消息。
