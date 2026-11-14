FROM node:24-alpine

# node:24-alpine 内置 node 用户（uid/gid 1000）；直接复用，避免与已有 gid 冲突。
RUN mkdir -p /app /app/node_modules /app/dist /opt/platform /home/app \
  && chown -R node:node /app /opt/platform /home/app

USER node
ENV HOME=/home/app \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    NODE_ENV=development

WORKDIR /app

# 该镜像只作为运行环境，具体命令由后端在启动容器时指定。
CMD ["node", "-e", "process.exit(0)"]
