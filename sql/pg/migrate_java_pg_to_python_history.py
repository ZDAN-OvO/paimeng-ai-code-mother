# /// script
# requires-python = "==3.13.*"
# dependencies = ["psycopg[binary]>=3.2,<4"]
# ///

import argparse
import os
import sys
from dataclasses import dataclass

import psycopg
from psycopg import sql

MAX_BIGINT = 2**63 - 1

COPY_SOURCE = """
COPY (
    SELECT id, "appId", "userId", "messageType", message, "createTime", "updateTime",
           CASE "isDelete" WHEN 0 THEN FALSE WHEN 1 THEN TRUE END
    FROM chat_history
    ORDER BY "appId", "createTime", id
) TO STDOUT WITH (ENCODING 'UTF8')
"""
COLUMNS = "id, app_id, user_id, message_type, message, created_at, updated_at, is_deleted"

VERIFY_ROWS = """
SELECT incoming.id
FROM incoming_history AS incoming
{join} chat_messages AS target ON target.id = incoming.id
WHERE target.task_id IS NOT NULL
   OR ROW(target.app_id, target.user_id, target.message_type, target.message,
          target.created_at, target.updated_at, target.is_deleted)
      IS DISTINCT FROM
      ROW(incoming.app_id, incoming.user_id, incoming.message_type, incoming.message,
          incoming.created_at, incoming.updated_at, incoming.is_deleted)
ORDER BY incoming.id
LIMIT 1
"""


class MigrationError(Exception):
    pass


@dataclass(frozen=True)
class MigrationReport:
    source_count: int
    app_count: int
    inserted: int


def connection_settings(prefix: str, database: str) -> dict:
    settings = {
        "host": os.getenv(f"{prefix}_HOST", "127.0.0.1"),
        "port": os.getenv(f"{prefix}_PORT", "5432"),
        "dbname": os.getenv(f"{prefix}_DATABASE", database),
        "connect_timeout": 5,
    }
    for suffix, key in (("USER", "user"), ("PASSWORD", "password")):
        name = f"{prefix}_{suffix}"
        value = os.getenv(name)
        if not value:
            raise MigrationError(f"请设置环境变量 {name}")
        settings[key] = value
    return settings


def migrate(source: psycopg.Connection, target: psycopg.Connection) -> MigrationReport:
    with source.transaction(), target.transaction():
        source.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        source.execute("SET LOCAL DateStyle = 'ISO, YMD'")
        target.execute("SET LOCAL DateStyle = 'ISO, YMD'")

        source_count, app_count, subsecond_count = source.execute("""
            SELECT count(*), count(DISTINCT "appId"),
                count(*) FILTER (
                    WHERE "createTime" <> date_trunc('second', "createTime")
                       OR "updateTime" <> date_trunc('second', "updateTime")
                )
            FROM chat_history
        """).fetchone()
        if subsecond_count:
            raise MigrationError(f"发现 {subsecond_count} 条时间精度超过秒的源记录，迁移已中止")

        target.execute("LOCK TABLE chat_sessions, chat_messages IN SHARE ROW EXCLUSIVE MODE")
        target.execute("""
            CREATE TEMP TABLE incoming_history (LIKE chat_messages) ON COMMIT DROP
        """)
        with source.cursor().copy(COPY_SOURCE) as exported, target.cursor().copy(
            f"COPY incoming_history ({COLUMNS}) FROM STDIN WITH (ENCODING 'UTF8')"
        ) as imported:
            for chunk in exported:
                imported.write(chunk)

        staged_count = target.execute("SELECT count(*) FROM incoming_history").fetchone()[0]
        if staged_count != source_count:
            raise MigrationError(f"源库与暂存行数不符（{source_count} / {staged_count}）")

        conflict = target.execute(VERIFY_ROWS.format(join="JOIN")).fetchone()
        if conflict:
            raise MigrationError(f"目标消息 ID {conflict[0]} 与源记录内容冲突")

        deleted_session = target.execute("""
            SELECT incoming.app_id
            FROM incoming_history AS incoming
            JOIN chat_sessions AS session ON session.app_id = incoming.app_id
            WHERE session.is_deleted
                AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE id = incoming.id)
            LIMIT 1
        """).fetchone()
        if deleted_session:
            raise MigrationError(f"目标应用 {deleted_session[0]} 已删除，无法追加迁移消息")

        target.execute("""
            INSERT INTO chat_sessions (app_id)
            SELECT DISTINCT app_id FROM incoming_history
            ON CONFLICT (app_id) DO NOTHING
        """)
        inserted = target.execute(f"""
            WITH inserted AS (
                INSERT INTO chat_messages ({COLUMNS})
                SELECT {COLUMNS} FROM incoming_history
                ON CONFLICT (id) DO NOTHING
                RETURNING app_id
            ), increments AS (
                SELECT app_id, count(*) AS delta FROM inserted GROUP BY app_id
            )
            UPDATE chat_sessions AS session
            SET version = session.version + increments.delta
            FROM increments WHERE increments.app_id = session.app_id
            RETURNING increments.delta
        """).fetchall()
        inserted_count = sum(row[0] for row in inserted)

        mismatch = target.execute(VERIFY_ROWS.format(join="LEFT JOIN")).fetchone()
        if mismatch:
            raise MigrationError(f"迁移后逐条核验失败，消息 ID {mismatch[0]}")
        if inserted_count:
            _restart_message_id(target)

    return MigrationReport(source_count=source_count, app_count=app_count, inserted=inserted_count)


def _restart_message_id(target: psycopg.Connection) -> None:
    max_id = target.execute("SELECT greatest(max(id), 0) FROM chat_messages").fetchone()[0]
    if max_id >= MAX_BIGINT:
        raise MigrationError("已迁入的消息耗尽了 BIGINT ID，无法继续生成新 ID")
    schema, sequence = target.execute("""
        SELECT namespaces.nspname, sequences.relname
        FROM pg_class AS sequences
        JOIN pg_namespace AS namespaces ON namespaces.oid = sequences.relnamespace
        WHERE sequences.oid = pg_get_serial_sequence('chat_messages', 'id')::regclass
    """).fetchone()
    target.execute(sql.SQL("ALTER SEQUENCE {} RESTART WITH {}").format(
        sql.Identifier(schema, sequence), sql.Literal(max_id + 1),
    ))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 Java PostgreSQL 的全部对话历史迁入 Python PostgreSQL，并逐条核验。"
    )
    parser.parse_args()
    try:
        source_config = connection_settings("JAVA_PG", "paimeng_java")
        target_config = connection_settings("PYTHON_PG", "paimeng_agent")
        with (
            psycopg.connect(**source_config, autocommit=True) as source,
            psycopg.connect(**target_config, autocommit=True) as target,
        ):
            if (
                source.info.hostaddr, source.info.port, source.info.dbname
            ) == (target.info.hostaddr, target.info.port, target.info.dbname):
                raise MigrationError("源库与目标库必须独立")
            report = migrate(source, target)
    except MigrationError as exc:
        print(f"迁移失败：{exc}", file=sys.stderr)
        return 1
    except psycopg.Error as exc:
        # 避免在复制错误的诊断中打印消息正文或连接凭据。
        print(f"迁移失败：{type(exc).__name__}（SQLSTATE {exc.sqlstate or '未知'}）", file=sys.stderr)
        return 1

    print(
        f"已逐条核验 {report.source_count} 条消息、{report.app_count} 个应用。"
        f"本次新增 {report.inserted} 条，复用 {report.source_count - report.inserted} 条。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
