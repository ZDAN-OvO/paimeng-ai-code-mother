#!/bin/sh
# PR 测试期间后端不允许操作 Docker：任何调用都要留下记录，并立刻失败。
printf '%s\n' "$*" >> "${DOCKER_AUDIT_FILE:-/dev/null}"
exit 1
