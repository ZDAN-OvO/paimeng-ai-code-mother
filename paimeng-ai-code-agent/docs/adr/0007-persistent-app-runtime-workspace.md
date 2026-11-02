# 持久 App Workspace 与跨轮复用的 App runtime

已接受，2026-11-03。替代 [ADR-0001](0001-single-writer-authority.md) 中每个 Execution 独立源码目录的选择，以及 [ADR-0002](0002-immutable-delivery.md) 中 Preview 始终只读 Delivery 的选择；Write authority、独立 Execution conversation、不可变 Version/Delivery 与下载/Deployment 的来源保持原有职责。

每个 App 的连续 Execution 在同一个持久 Workspace 工作，runtime supervisor 将它与共享 pnpm store 挂载到该 App 的常驻容器。node_modules 位于 Workspace 内，正常下一轮复用同一容器、端口和目录；实时 Preview 代理该容器的 dev server 与 HMR。每轮换目录重建容器会失去常驻运行环境与 dev server 连续性，因此不采用。

共享源码目录使单次写前的 epoch 检查不足以阻止迟到写入。真实文件写入、基线替换与封存都在 App → authority 行锁内完成，接管等待已准入写入退出；安装、模型调用与构建留在事务外。新基线先完整物化并校验，替换时只移动源码条目、失败还原，不替换根 inode，以保持 bind mount 与依赖有效。执行门闩仍绑定根、generationId、epoch，平台 owner 标记只用于识别引用，数据库 Write authority 才是写权限真值。

源码交接仍使用不可变 Source snapshot；失败、取消与 Question 留下的 Draft 供下一轮继续。成功发布从封存快照构造 Version，发布后只同步平台 Git HEAD/index，避免迟到的源码镜像覆盖新一轮。Preview 在 runtime 不可用时回落 Delivery，下载与 Deployment 继续解析不可变产物。
