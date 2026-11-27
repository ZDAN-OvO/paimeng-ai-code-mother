# /// script
# requires-python = "==3.13.*"
# dependencies = ["psycopg[binary]>=3.2,<4", "redis>=5,<7"]
# ///

"""使用 Java 相同的 Redis 维护屏障并核对源 PG 的待恢复记录。"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from uuid import UUID, uuid4

import psycopg
import redis

LUA = (
    Path(__file__).resolve().parents[2]
    / "paimeng-backend/src/main/resources/cutover/write-barrier.lua"
)


def show(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, default=str), flush=True)


def pending_in_postgres(dsn: str) -> dict:
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as connection:
        connection.execute("SET statement_timeout = '5s'")
        return connection.execute("""
            SELECT json_build_object(
                'generation', ARRAY(
                    SELECT task_id::text || ':' || status
                    FROM generation_task
                    WHERE status IN ('RUNNING', 'COMMITTING')
                       OR cleaned_at IS NULL OR NOT result_committed
                    ORDER BY created_at LIMIT 20
                ),
                'history_deletion', ARRAY(
                    SELECT app_id::text FROM generation_history_deletion ORDER BY app_id LIMIT 20
                )
            )
            """).fetchone()[0]


def await_seal(client, key: str, call, epoch: str, timeout: float, interval: float) -> int:
    dsn = os.environ["WRITE_BARRIER_PG_DSN"]
    deadline = time.monotonic() + timeout
    last_report = None
    while True:
        state = client.hgetall(key)
        if state.get("epoch") != epoch or state.get("mode") not in {"closed", "sealed"}:
            raise ValueError("Redis 屏障没有停写，或停写批次已改变")
        if state["mode"] == "sealed":
            show({
                "result": "java_drained",
                "epoch": epoch,
                "sealed_at_utc": datetime.fromtimestamp(float(state["sealed_at"]), timezone.utc),
            })
            return 0
        entries = {name: value for name, value in state.items() if name not in {"mode", "epoch"}}
        if any(name.startswith("failed:") for name in entries):
            show({"result": "unresolved_failures", "epoch": epoch, "redis": entries})
            return 1
        pending = None
        if not entries:
            pending = pending_in_postgres(dsn)
            if not any(pending.values()) and time.monotonic() < deadline:
                result = call("seal", epoch)
                if result not in {"busy", "wrong-epoch", "wrong-mode", "missing"}:
                    show({
                        "result": "java_drained",
                        "epoch": epoch,
                        "sealed_at_utc": datetime.fromtimestamp(float(result), timezone.utc),
                    })
                    return 0
                if result != "busy":
                    raise ValueError(f"封闭屏障失败 {result}")
        report = {"epoch": epoch, "redis": entries, "postgres_pending": pending}
        if report != last_report:
            show({"result": "draining", **report})
            last_report = report
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            show({"result": "timeout", **report})
            return 1
        time.sleep(min(interval, remaining))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="控制 Java 跨实例停写屏障",
        epilog=(
            "所有 Java 实例和本工具使用相同的 TASK_REDIS_URL（db 2）和 WRITE_BARRIER_NAMESPACE。"
            "仅对新环境执行 init。await 通过 WRITE_BARRIER_PG_DSN 核对源 Java PG。"
            "java_drained 表示 Java 写入和恢复已封闭。迁移前还需核对独立写入方。"
        ),
    )
    actions = parser.add_subparsers(dest="action", required=True)
    for name in ("init", "status", "pause"):
        actions.add_parser(name)
    for name in ("await", "resume", "abort", "resolve-failed", "resolve-stopped"):
        action = actions.add_parser(name)
        action.add_argument("epoch", type=UUID, help="pause 输出的停写批次")
        if name == "await":
            action.add_argument("--timeout", type=float, default=60, help="最长等待秒数")
            action.add_argument("--interval", type=float, default=0.5, help="状态检查间隔秒数")
        if name.startswith("resolve-"):
            action.add_argument("ticket", type=UUID, help="Redis 登记号")
            action.add_argument("--evidence", required=True, help="修复、重试或实例确已退出的证据")
    args = parser.parse_args()
    namespace = os.getenv("WRITE_BARRIER_NAMESPACE", "paimeng:cutover")
    if not namespace.strip():
        parser.error("WRITE_BARRIER_NAMESPACE 不能为空")
    key = f"{namespace}:writes"

    try:
        with redis.Redis.from_url(
            os.environ["TASK_REDIS_URL"], decode_responses=True,
            socket_timeout=5, socket_connect_timeout=5,
        ) as client:
            if client.connection_pool.connection_kwargs.get("db") != 2:
                parser.error("TASK_REDIS_URL 必须指向独立 Redis db 2")
            if args.action == "status":
                state = client.hgetall(key)
                show(state or {"mode": "uninitialized"})
                return 0 if state else 1

            script = client.register_script(LUA.read_text(encoding="utf-8"))

            def call(operation, *arguments):
                return script(keys=[key], args=[operation, *map(str, arguments)])

            if args.action == "await":
                if not (0 < args.timeout < float("inf") and 0 < args.interval < float("inf")):
                    parser.error("等待秒数和检查间隔必须是有限正数")
                return await_seal(client, key, call, str(args.epoch), args.timeout, args.interval)
            if args.action == "pause":
                result = call("pause", uuid4())
                if result == "missing":
                    raise ValueError("屏障尚未初始化")
                show({"epoch": result, "result": "admission_closed"})
                return 0
            if args.action == "init":
                result = call("init", uuid4())
            elif args.action.startswith("resolve-"):
                if not args.evidence.strip():
                    parser.error("必须填写处理证据")
                prefix = "failed" if args.action == "resolve-failed" else "active"
                result = call("resolve", args.epoch, f"{prefix}:{args.ticket}")
                show({"result": result, "ticket": args.ticket, "evidence": args.evidence})
                return 0 if result == "ok" else 1
            else:
                result = call(args.action, args.epoch)
            show({"result": result})
            return 0 if result == "ok" else 1
    except KeyError as error:
        print(f"缺少环境变量 {error.args[0]}", file=sys.stderr)
        return 1
    except (OSError, ValueError, redis.RedisError, psycopg.Error) as error:
        print(f"无法确认屏障状态（{type(error).__name__}）", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
