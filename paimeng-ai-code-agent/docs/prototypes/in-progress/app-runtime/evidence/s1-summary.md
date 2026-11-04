# S1 结果：pnpm store 与 Workspace 的挂载边界

- 镜像：`paimeng-app-runtime:1894779bd433`（`sha256:d86ae2e4791f`），pnpm 10.18.3，Node v24.22.1
- 锁文件：lockfileVersion: '9.0'
- 跨挂载 link：CROSS_MOUNT_LINK_FAIL: ln: /work/p.txt: Cross-device link

| 布局 | 安装耗时 | store 分配 | workspace 分配 | 合并分配 | 硬链接文件 | 最大 nlink |
| --- | --- | --- | --- | --- | --- | --- |
| naive | — | 64.8 MiB | 64.7 MiB | 129.5 MiB | 0 | 1 |
| workaround A | — | 65.1 MiB | 0.1 MiB | 65.2 MiB | 0 | 1 |
| workaround A+B | — | 65.3 MiB | 0.1 MiB | 65.4 MiB | 0 | 1 |
| same-mount | — | 64.8 MiB | 64.4 MiB | 65.2 MiB | 2384 | 18 |

第二份 App 追加 store 分配：0.25 MiB；合并分配增量：0.25 MiB。

