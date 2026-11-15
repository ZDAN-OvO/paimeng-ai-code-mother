# 生成的代码只在 Docker 容器中运行，后端通过 Docker CLI 调度

生成的代码不可信，因此安装、检查、构建和预览都在加固过的 Docker 容器中进行：非 root、只读根文件系统、去除 capabilities、无出口网络、不发布宿主机端口，也不挂载 Docker socket。后端在宿主机运行，以固定参数调用 Docker CLI，只操作带 `paimeng.project=paimeng-ai-code-mother` 标签的对象。不能满足隔离条件时拒绝执行，不回退到宿主机运行。

## Considered Options

- 宿主机子进程：最简单，但生成代码能读到平台文件、环境变量和网络。
- Docker Engine API SDK：调用更结构化，但需要暴露 socket 给后端库，并多一层依赖；CLI 的参数可以逐项审查和测试。
- gVisor、Firecracker 等更强的沙箱：隔离更好，但单机部署成本更高，留作以后替换。
