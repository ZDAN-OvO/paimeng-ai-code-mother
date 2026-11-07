FROM node:24-alpine

# Spike image: the same shape as the planned runtime image (Node + git + fixed pnpm).
RUN apk add --no-cache git \
  && npm install -g pnpm@10.18.3 \
  && pnpm --version \
  && git --version
