# S3 结果：shell 后台写入与轮末停止屏障

- 镜像：`paimeng-app-runtime:1894779bd433`，Node v24.22.1，pnpm 10.18.3
- 假 dev server PID：7（pong 2）

| 场景 | 结果 | 屏障后稳定 | wrapper 返回 | 屏障耗时 | 剩余进程 | 僵尸 |
| --- | --- | --- | --- | --- | --- | --- |
| detached 后台写者，无屏障 | **仍然迟到写入** | — | — ms | — | — | — |
| 现有 wrapper，detached 后台写者，无屏障 | **仍然迟到写入** | — | 549 ms | — | — | — |
| 现有 wrapper + 轮末屏障，detached | 无迟到写入 | 是 | 553 ms | 8 ms | 0 | 8 |
| 现有 wrapper，后台进程继承 stdout | **仍然迟到写入** | — | 1548 ms | — | — | — |
| 现有 wrapper，后台进程继承 stdout + 2s 超时 | 无迟到写入 | — | 2046 ms | — | — | — |
| 双 fork daemon + 屏障 | 无迟到写入 | 是 | 538 ms | 11 ms | 0 | 19 |
| 忽略 TERM + 屏障 | 无迟到写入 | 是 | 540 ms | 11 ms | 0 | 23 |
| 50 个 detached 写者 + 屏障 | 无迟到写入 | 是 | 539 ms | 47 ms | 0 | 125 |
| 连续写入进程 + 屏障 | **仍然迟到写入** | 是 | 542 ms | 44 ms | 0 | 129 |
| 冻结 dev server + 屏障 | 无迟到写入 | 是 | 541 ms | 646 ms | 0 | 133 |

- 冻结 dev server：心跳在冻结窗口内不变=true；CONT 后恢复写入=true；ping={"status":0,"stdout":"pong 373"}
- 僵尸：无 init=20；有 init=0
- 整容器 kill/start：kill 98 ms，start 95 ms；迟到写入=false；dev server 自动恢复=false

