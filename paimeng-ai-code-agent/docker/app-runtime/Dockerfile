# App runtime 镜像：给生成出的前端工程跑依赖安装与 dev server。
#
# 身份只由 BASE_IMAGE 与 PNPM_VERSION 决定（src/server/runtime/plan.ts 的 runtimeImageTag）。
# 镜像里不放平台代码、不接平台密钥；容器只挂 App 自己的 Workspace 与共享 pnpm store。

ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}

ARG PNPM_VERSION=10.18.3

# 基础镜像可能是 alpine 也可能是 debian 系，按可用的包管理器装 git（版本化与依赖常见需要）。
RUN if command -v apk >/dev/null 2>&1; then apk add --no-cache git; \
    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*; \
    else echo "unsupported base image: no apk or apt-get" >&2; exit 1; fi

RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version && git --version

# 容器以宿主 uid/gid 运行，工作目录由 bind mount 提供；这里只声明默认位置。
WORKDIR /work
