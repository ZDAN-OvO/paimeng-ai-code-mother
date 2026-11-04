# App runtime spike 报告

日期：2026-11-03。基线：`main` `13ef405b092afe704776ed8a4f0dd736457800ae`（工作树当时只有计划文档）。
本报告是 throwaway spike 的结论，不是生产实现。原始数字在 `evidence/`，复现入口在 `README.md`。

## 结论

| 问题 | 结论 | 采用的做法 |
| --- | --- | --- |
| S1 pnpm 跨挂载 | 两个独立 bind mount 之间 `link()` 返回 `EXDEV`，pnpm 退化为复制；默认 virtual store 会让磁盘翻倍 | virtual store 放进 store 挂载：`/store/apps/<key>/.paimeng-virtual`；Workspace 的 `node_modules` 只存指向它的符号链接 |
| S2 HMR 子路径代理 | Vite 7 的 HTTP、模块、HMR WebSocket 都能走 `/preview/<key>/`；两个 App 不串流 | 代理 HTTP + upgrade；Vite `--base`；**不要**设置 `server.hmr.clientPort` |
| S3 轮末停止屏障 | 现有 wrapper 正常返回时不杀进程组；detached 进程会逃逸。先 TERM 再 KILL 会让忽略 TERM 的 shell 抢写 | 每轮收束：冻结 dev server → SIGSTOP 全部非白名单进程 → SIGKILL → 快照 → 停 dev server；容器加 `--init` |

## 环境

| 项 | 值 |
| --- | --- |
| 镜像 | `paimeng-app-runtime:1894779bd433`（`sha256:d86ae2e4791f...`），本地标签 |
| Node / pnpm / git | v24.22.1 / 10.18.3 / 2.54.0 |
| Docker / 内核 | 29.8.2 / 7.0.0-38-generic |
| 宿主 | Linux x86_64，uid 1000；Workspace 与 store 在同一宿主文件系统 |
| 锁文件 | pnpm lockfileVersion 9.0 |
| 镜像来源 | 远端分支 `agent/app-runtime-136-144` 的 `runtimeDockerfile` 形状（`node:24-alpine` + git + 固定 pnpm）；`spike/Dockerfile` 是可重建版本 |

镜像是本地标签，不是 digest 固定的生产镜像。绝对 MiB 只对这台机器和这个镜像成立；结论依赖 inode/nlink 与比例，不依赖单个绝对值。

## S1：pnpm 共享 store 与两个 bind mount

### 方法

同一份 `package.json` 和锁文件，在三种布局下真实安装 React 19 / Vite 7 / TypeScript：

- **naive**：`/work`（Workspace）与 `/store`（store）两个 bind mount，virtual store 留在默认的 `/work/node_modules/.pnpm`。
- **workaround**：同样两个 mount，但 `--virtual-store-dir=/store/apps/<key>/.paimeng-virtual`；两个 App 各一份。
- **same-mount 对照**：`/srv` 一个父挂载，里面同时有 `store/` 与 `work/`，默认 virtual store。

另外做了 `link()` 探针、两个 App 并发安装、宿主用户删除容器文件。

### 结果

| 布局 | store 分配 | Workspace 分配 | 合并分配 | Workspace 硬链接文件 | 最大 nlink |
| --- | --- | --- | --- | --- | --- |
| naive | 64.8 MiB | 64.7 MiB | **129.5 MiB** | 0 | 1 |
| workaround A | 65.1 MiB | 0.1 MiB | **65.2 MiB** | 0（Workspace 里是符号链接） | 1 |
| workaround A+B | 65.3 MiB | 0.1 MiB | **65.4 MiB** | 0 | 1 |
| same-mount | 64.8 MiB | 64.4 MiB | **65.2 MiB** | 2384 | 18 |

- `ln /store/probe.txt /work/probe-link.txt`：`Cross-device link`。注意两个挂载的 `stat -c %d` 都是 `66308`；`st_dev` 相同并不代表 `link()` 成功，挂载 ID 才是边界。
- 两个 App 的同一个 `react/index.js` 在 store 与两份 virtual store 中 `dev:ino:nlink = 66308:3155809:3`；Workspace 的 `node_modules/react` 只是指向 virtual store 的相对符号链接。
- 第二个 App 只追加 **0.25 MiB** store 分配（目录/元数据），相对 65 MiB 的包体可忽略。
- 两个 App 并发安装共享 store：两个进程都退出 0（3.1 s / 3.1 s，store 已预热）。
- 容器以 uid 1000 写出的文件，宿主用户可直接 `rm -rf`，属主为 `1000:1000`。

### 解释

pnpm 的包文件从内容寻址 store **硬链接**到 virtual store；`node_modules` 里的条目再符号链接到 virtual store。跨 bind mount 时，硬链接失败，pnpm 退化为复制，包体在 store 与 Workspace 各一份。把 virtual store 移进 store 挂载后，硬链接发生在 store 挂载内部，Workspace 只剩符号链接和 `.modules.yaml`。

### 对实现的约束

- `runtimeMounts` 保持两个 mount；`runtimeVirtualStore(app)` 固定为 `${RUNTIME_STORE}/apps/<codeGenType>_<appId>/.paimeng-virtual`。
- 平台安装和模型自己执行的 `pnpm` 都必须使用同一个 `--virtual-store-dir`（或 `npm_config_virtual_store_dir`）；否则模型一次默认安装就会在 Workspace 里再复制一份。
- 删除 App 时删 `/store/apps/<key>`，不能删共享 store 根；`.paimeng-virtual` 是 App 私有目录。
- 系统测试要断言 inode/nlink 与第二 App 增量，不能只看“安装成功”。

### 否决的替代

- 两 mount + 默认 `.pnpm`：磁盘翻倍，直接违背“共享 store 承担磁盘”的目标。
- 一个父挂载同时暴露 Workspace 与 store：硬链接可行，但容器能看到其他 App 的目录；除非再做 per-App 视图，否则不采用。
- 退回 npm / 只读依赖层：失去模型自行安装依赖的能力。

## S2：Vite HMR 走 `/preview/<key>/` 代理

### 方法

两个最小 Vite 7 App，各自 `--base /preview/<key>/`、独立端口。一个最小 Node 代理处理：

- HTTP：原样转发路径，HTML 注入桥接脚本，设置 CSP（`connect-src 'self' ws: wss:`，`frame-ancestors` 宿主 origin）。
- WebSocket：`server.on('upgrade')`，把原始请求行与头转给 dev server，双向透传字节。

用 Playwright/Chromium 在宿主页 iframe 里打开 App A，写入 `dep.js` 五次，每次等待 DOM 文本变化，并检查页面上的 `window.__probe` 是否保留（证明不是整页刷新）。

### 结果

- 首次加载：marker、桥接脚本、模块入口都正常。
- 5 次 HMR：**56 / 59 / 61 / 59 / 56 ms**；页面探针保留，说明没有整页刷新。
- HMR WebSocket：`ws://127.0.0.1:3101/preview/react_project_700000001/?token=...`；收到 6 帧，其中包含 Vite 的 update 帧。
- 第二个 App：同一代理、不同端口；HMR 后探针保留；A 的页面没有出现 B 的内容。
- SPA 深链 `/preview/<key>/settings`：200，index.html 正常。
- `pageErrors=0`，`requestfailed=0`，`consoleErrors=0`。
- 截图：`evidence/s2-hmr.png`。

### 解释

Vite 只在 `server.hmr.clientPort` 或 `hmr.port` 显式设置时才注入 `__HMR_PORT__`；只传 `--base` 时该值为空，客户端回退到页面端口（代理端口 3101），因此 WebSocket 自然落在代理上。如果模板或配置把 `clientPort` 设成 dev server 的 5173，浏览器会尝试直连未暴露的端口，HMR 断掉。

### 对实现的约束

- 代理必须先注册 `upgrade`，HTTP 与 WS 共用同一套 App→端口映射；路径不改写，Vite 的 `base` 负责资源与 HMR 路径。
- CSP 必须允许 `ws:`/`wss:`（或精确的代理 origin），否则 HMR 被浏览器拦掉；`frame-ancestors` 保持平台 origin。
- 模板/运行时不要设置 `server.hmr.clientPort`、`hmr.port`；如果模板自带，平台要覆盖或拒绝。
- 两个 App 的端口、base、WebSocket 必须隔离；未知 App 直接拒绝，不能落到默认端口。

### 局限

spike 代理是最小实现，不是产品的 `preview.ts`。Cookie 隔离、Host 校验、编辑桥接的锁定语义、生产 CSP、错误页与真实 Vite 插件未覆盖；这些仍由 PR-05 的 system/E2E 证明。

## S3：shell 后台进程与轮末屏障

### 方法

真实容器（uid 1000，`--pids-limit 256`，`--memory 512m`），一个假 dev server（每 100ms 写心跳）和一个“平台命令执行器”：

- 现有 wrapper：从远端 `shell.ts` 复制的 `setsid sh -c 'echo $$ > pid; exec sh -lc "$2"'` + 进程组看门狗（超时才 TERM/KILL）。
- 新屏障：枚举 `/proc`，冻结 dev server 树，把非白名单进程 `SIGSTOP`，再 `SIGKILL`，等待退出，快照文件 hash，最后 `SIGCONT`（spike 版）或停 dev server（推荐版）。
- 每个场景独立文件，避免上一个场景的迟到写入污染结论。

### 结果

| 场景 | 结果 | 屏障后稳定 | wrapper 返回 | 屏障耗时 | 剩余进程 |
| --- | --- | --- | --- | --- | --- |
| detached 后台写者，无屏障 | 仍然迟到写入 | — | — | — | — |
| 现有 wrapper，detached 写者，无屏障 | 仍然迟到写入 | — | 549 ms | — | — |
| 现有 wrapper + 轮末屏障，detached | 无迟到写入 | 是 | 553 ms | **8 ms** | 0 |
| 现有 wrapper，后台进程继承 stdout | 写入发生在返回前 | — | **1548 ms** | — | — |
| 现有 wrapper，继承 stdout + 2 s 超时 | 超时被杀，无迟到写入 | — | 2046 ms | — | — |
| 双 fork daemon + 屏障 | 无迟到写入 | 是 | 538 ms | 11 ms | 0 |
| 忽略 TERM + 屏障 | 无迟到写入 | 是 | 540 ms | 11 ms | 0 |
| 50 个 detached 写者 + 屏障 | 无迟到写入 | 是 | 539 ms | **47 ms** | 0 |
| 连续写入进程 + 屏障 | 屏障前已有写入；屏障后无新写入 | 是 | 542 ms | 44 ms | 0 |
| 冻结 dev server + 屏障 | 无迟到写入；心跳在冻结窗口内不变；CONT 后恢复 | 是 | 541 ms | 646 ms | 0 |

- 无 `--init` 的容器：20 个被杀进程留下 **20 个僵尸**；`docker --init`（tini）容器：**0**。
- 整容器 `docker kill` + `docker start`：**98 ms / 95 ms**；无迟到写入；dev server 不会自动恢复（下一轮必须重启）。
- 冻结测试：`heartbeatUnchangedWhileFrozen=true`，`CONT` 后心跳恢复，`/ping` 返回 200。

### 三个独立发现

1. **正常返回不杀进程组。** 现有 wrapper 只在超时分支执行 `kill -TERM -pid`；`wait "$child"` 返回后只杀看门狗。detached 写者（`setsid ... >/dev/null 2>&1 &`）在 wrapper 返回后继续存活，2.6 s 后写入。双 fork daemon 同理。
2. **`docker exec` 会被继承 stdout 的后台进程拖住。** 一个 `sleep 1.5` 的后台写者让 exec 在 1548 ms 才返回；`sleep 20` 则只能等 2 s 超时。这不是“返回后泄漏”，而是“命令的耗时被后台进程劫持”。平台必须用命令超时兜底，不能把返回当成进程树结束。
3. **TERM 宽限期本身会诱发写入。** 忽略 TERM 的 shell 在其 `sleep` 子进程被 TERM 杀死后，会立刻执行下一句 `echo`，抢在 800 ms 宽限期结束前落盘。改成先 `SIGSTOP` 所有非白名单进程、再 `SIGKILL` 后，屏障从 800 ms 降到 8–47 ms，且没有迟到写入。

### 推荐

每轮收束（成功、失败、取消、提问暂停）都执行：

1. 记录/识别 dev server 树（启动时记 pid/sid）。
2. `SIGSTOP` dev server 树。
3. 枚举 `/proc`；忽略 PID 1、屏障自身与祖先、dev 树、僵尸。
4. 对每个其余进程 `SIGSTOP`；等待状态变成 `T`（或消失），最多 800 ms。
5. 对它们 `SIGKILL`；等待非僵尸进程消失，最多 4 s。
6. 快照/提交 Workspace。
7. **停掉 dev server**（不要 `SIGCONT` 后继续跑）；下一轮在同一容器里重启。若选择保留 dev server，至少要冻结到下一轮开始，且在 `CONT` 前完成所有读取；真实 Vite 插件可能在 `CONT` 后写缓存或源码。
8. 容器以 `--init` 启动；否则僵尸会累积到 `--pids-limit`。

屏障开销 8–47 ms（50 个写者 47 ms），远低于整容器重启的 193 ms；它保留容器、依赖与安装状态，只重启 dev server。整容器 `docker kill` + `start` 是更强的兜底（98/95 ms，绝对无残留），但会丢掉 dev server，下一轮必须重建；如果屏障实现难以证明，退回整容器重启是可接受的保守方案。

### 对实现的约束

- 不要在正常返回路径上假设“命令结束”；轮末屏障独立于 wrapper，必须每次运行。
- 不要先 TERM 再等待；先冻结再杀。TERM 只适合“允许优雅退出”的进程，不适合“提交前绝不能写”的边界。
- 容器加 `--init`（或自带 tini），并测试僵尸计数。
- 命令超时与取消走同一屏障，而不是只杀 `docker exec` 客户端。
- dev server 由平台启动，但会执行生成代码/插件；提交前必须冻结或停掉它，不能把它排除在屏障外。

### 局限

假 dev server 只证明进程控制，不证明真实 Vite 插件在冻结/重启边界的行为；S3 没有测真实 Vite 的 watcher 在 `SIGSTOP`/`SIGCONT` 后是否会补发事件。生产实现应在 PR-04/05 的 system 测试里用真实 Vite 复测“冻结→快照→停→下一轮重启”的整条链。

## 与既有分支的关系

远端已有实现分支 `origin/agent/app-runtime-136-144`，包含：

- `6d6b45e`（#137）版本库移出 Workspace、提交上限；
- `e63b178`（#138）React 厚模板与二分类；
- `60350e0`（#139）常驻 runtime、Preview 实时代理；
- `c5062da`（#140）shell 与依赖归一化；
- `4bf37dd`（#144）槽位排队、空闲回收、静态回落。

当前 `main` `13ef405` 不包含这些提交。该分支的 `plan.ts` 注释已经写了“跨 bind mount 的 link() 会 EXDEV，pnpm 只能复制”，并给出把 virtual store 放进 store 挂载的做法；`preview.ts` 已经注册 `upgrade`；`system/app-runtime.test.ts` 用真实 Docker + Vite + Playwright 测过 HMR 与两 App 隔离。这些是本次 spike 的 prior art，不是本次结论的唯一依据。

同时，分支的 `integration/harness/shell-tool.test.ts` 明确写着“这里不启动 Docker”，只测封存门禁与 40 条预算；`shell.ts` 的 wrapper 只在超时分支杀进程组；`runtimeRunArgs` 没有 `--init`。本次 S3 补上了这三处未覆盖的边界，并给出了不同的收束策略。分支代码不能直接当作“S3 已解决”的证据。

## 对计划的直接影响

- **PR-02**：挂载保持两个；固定 virtual store 路径与环境变量；镜像加 `--init`；system 测试增加 inode/nlink、第二 App 增量、僵尸计数、50 个写者的屏障耗时。
- **PR-03**：队列/唤醒不改变 Workspace 的挂载布局；轮末交接使用 PR-04 的屏障；不要用“exec 返回”作为交接条件。
- **PR-04**：shell 工具保留命令超时/40 条/8 KiB，但正常返回也要跑屏障；先 SIGSTOP 再 SIGKILL；忽略 TERM 的场景必须通过；容器加 reaper；测试要真实 Docker，不能只测拒绝路径。
- **PR-05**：Vite `--base` + 代理 `upgrade`；不设置 `clientPort`；收束时冻结→快照→停 dev server；下一轮重启 dev server；用真实 Vite 复测 HMR 与重启。
- **PR-07**：D2 已确认“最近成功 Delivery 回落”；部署从 commit 构建，不受 runtime 停止影响。
- **D1**：token 计费口径已确认；排队、唤醒、安装、命令、构建不新增时间费。

## 复现与证据

```bash
node docs/prototypes/in-progress/app-runtime/spike/s1-hardlinks.mjs
node docs/prototypes/in-progress/app-runtime/spike/s2-hmr-proxy.mjs
node docs/prototypes/in-progress/app-runtime/spike/s3-stop-barrier.mjs
```

- `evidence/s1.json` / `s1-summary.md`：布局、inode 样本、分配字节、并发、属主。
- `evidence/s2.json` / `s2-summary.md` / `s2-hmr.png`：HMR 时序、WebSocket 帧、两 App 隔离、深链、控制台错误。
- `evidence/s3.json` / `s3-summary.md`：每个场景的迟到写入、屏障耗时、僵尸、冻结/恢复、整容器 kill/start。
- `spike/`：可复现脚本与 Dockerfile；容器名带唯一前缀，`finally` 清理。
- 重型依赖与安装产物在 `/tmp/app-runtime-spike-*`，可丢弃；仓库只保留脚本与小型 JSON/截图。

## 未证明

- 真实 Vite 插件在 `SIGSTOP`/`SIGCONT` 或 dev server 重启边界的行为。
- 产品 `preview.ts` 的 Cookie、Host、CSP、编辑桥接、错误页与真实浏览器回归。
- 多用户共享 store 的隔离、磁盘配额、网络故障、镜像升级、Postgres 队列/槽位调度。
- 真实模型的 shell 使用模式（是否会留下长时间后台进程）。
- 本机镜像的冷安装时间；本次多数安装命中了预热 store。冷安装需单独测，预算不能拿热数据冒充。
