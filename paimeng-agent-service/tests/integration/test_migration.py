from datetime import datetime
from pathlib import Path
from runpy import run_path

import psycopg
import pytest
from psycopg import sql

pytestmark = pytest.mark.integration
MIGRATION_PATH = Path(__file__).resolve().parents[3] / "sql" / "pg" / "migrate_java_pg_to_python_history.py"
namespace = run_path(str(MIGRATION_PATH))
migrate = namespace["migrate"]
MigrationError = namespace["MigrationError"]


@pytest.fixture
def databases(postgres_schemas):
    dsn, target_schema, source_schema = postgres_schemas
    with (
        psycopg.connect(dsn, autocommit=True) as source,
        psycopg.connect(dsn, autocommit=True) as target,
    ):
        source.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(source_schema)))
        target.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(target_schema)))
        source.execute("""
            CREATE TABLE chat_history (
                id BIGINT PRIMARY KEY, message TEXT NOT NULL, "messageType" VARCHAR(32) NOT NULL,
                "appId" BIGINT NOT NULL, "userId" BIGINT NOT NULL, "createTime" TIMESTAMP NOT NULL,
                "updateTime" TIMESTAMP NOT NULL, "isDelete" SMALLINT NOT NULL
            )
        """)
        yield source, target


def test_preserves_all_fields_and_order_with_repeatable_import(databases):
    source, target = databases
    when = datetime(2026, 11, 25, 21, 32, 1)
    updated = datetime(2026, 11, 25, 21, 32, 2)
    high_id = 1900000000000000000
    imported_rows = [
        (high_id + 2, "多行\r\n空值标记 \\N", "ai", 123, 456, when, updated, 0),
        (2, "旧历史第一条", "user", 123, 456, when, when, 0),
        (10, "另一应用已删消息", "ai", 321, 654, when, updated, 1),
        (high_id + 3, "Java PG 过渡期新消息", "user", 123, 456, updated, updated, 0),
    ]
    with source.cursor() as cursor:
        cursor.executemany("INSERT INTO chat_history VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", imported_rows)

    report = migrate(source, target)
    assert (report.source_count, report.app_count, report.inserted) == (4, 2, 4)
    expected = source.execute("""
        SELECT id, message, "messageType", "appId", "userId", "createTime", "updateTime", "isDelete" <> 0
        FROM chat_history ORDER BY "appId", "createTime", id
    """).fetchall()
    rows = target.execute("""
        SELECT id, message, message_type, app_id, user_id, created_at, updated_at, is_deleted
        FROM chat_messages ORDER BY app_id, created_at, id
    """).fetchall()
    assert rows == expected
    assert migrate(source, target).inserted == 0
    assert target.execute("SELECT app_id, version FROM chat_sessions ORDER BY app_id").fetchall() == [(123, 3), (321, 1)]

    message_id = target.execute("""
        INSERT INTO chat_messages (message, message_type, app_id, user_id)
        VALUES ('Python 新消息', 'user', 123, 456) RETURNING id
    """).fetchone()[0]
    assert message_id == high_id + 4

    source.execute("UPDATE chat_history SET message = '冲突内容' WHERE id = 2")
    with pytest.raises(MigrationError, match="目标消息 ID 2"):
        migrate(source, target)
    assert target.execute("SELECT message FROM chat_messages WHERE id = 2").fetchone()[0] == "旧历史第一条"


def test_rejects_subseconds_without_truncating_data(databases):
    source, target = databases
    timestamp = datetime(2026, 11, 25, 21, 32, 1, 500_000)
    source.execute("INSERT INTO chat_history VALUES (1,'消息','user',1,2,%s,%s,0)", (timestamp, timestamp))
    with pytest.raises(MigrationError, match="时间精度超过秒"):
        migrate(source, target)
    assert target.execute("SELECT count(*) FROM chat_messages").fetchone()[0] == 0
