# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "PyMySQL[rsa]>=1.1,<2",
#     "psycopg[binary]>=3.2,<4",
# ]
# ///

import argparse
import os
import sys

import psycopg
import pymysql
from psycopg import sql


TABLE_COLUMNS = {
    "user": (
        "id", "userAccount", "userPassword", "userName", "userAvatar",
        "userProfile", "userRole", "editTime", "createTime", "updateTime", "isDelete",
    ),
    "app": (
        "id", "appName", "cover", "initPrompt", "codeGenType", "deployKey",
        "deployedTime", "priority", "userId", "editTime", "createTime",
        "updateTime", "isDelete",
    ),
    "chat_history": (
        "id", "message", "messageType", "appId", "userId", "createTime",
        "updateTime", "isDelete",
    ),
}


class MigrationError(Exception):
    pass


def connection_settings(prefix, database_key):
    settings = {}
    for env_key, parameter in (
        ("HOST", "host"),
        ("PORT", "port"),
        ("USER", "user"),
        ("PASSWORD", "password"),
        ("DATABASE", database_key),
    ):
        name = f"{prefix}_{env_key}"
        value = os.environ.get(name)
        if value is None or (not value and env_key != "PASSWORD"):
            raise MigrationError(f"请设置环境变量 {name}")
        settings[parameter] = value
    try:
        port = int(settings["port"])
    except ValueError:
        raise MigrationError(f"{prefix}_PORT 必须是 1 至 65535 的端口号") from None
    if not 1 <= port <= 65535:
        raise MigrationError(f"{prefix}_PORT 必须是 1 至 65535 的端口号")
    settings["port"] = port
    return settings


def start_source_snapshot(source):
    with source.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        cursor.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        cursor.execute(
            """
            SELECT TABLE_NAME, ENGINE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (%s, %s, %s)
            """,
            tuple(TABLE_COLUMNS),
        )
        engines = dict(cursor.fetchall())
    for table in TABLE_COLUMNS:
        if engines.get(table) != "InnoDB":
            raise MigrationError(f"源表 {table} 必须存在且使用 InnoDB，才能读取一致性快照")


def source_table(table):
    return sql.Identifier("pg_temp", f"mysql_{table}")


def target_table(table):
    return sql.Identifier("public", table)


def copy_source(source, target, table, columns):
    stage = source_table(table)
    target.execute(
        sql.SQL("CREATE TEMP TABLE {} (LIKE {}, PRIMARY KEY (id)) ON COMMIT DROP").format(
            stage, target_table(table),
        )
    )
    mysql_columns = ", ".join(f"`{column}`" for column in columns)
    copy = sql.SQL("COPY {} ({}) FROM STDIN").format(
        stage, sql.SQL(", ").join(map(sql.Identifier, columns)),
    )
    with source.cursor(pymysql.cursors.SSCursor) as reader:
        reader.execute(f"SELECT {mysql_columns} FROM `{table}`")
        with target.copy(copy) as writer:
            for row in reader:
                writer.write_row(row)


def verify_references(target):
    for child, column, parent in (
        ("app", "userId", "user"),
        ("chat_history", "appId", "app"),
        ("chat_history", "userId", "user"),
    ):
        missing_parent = target.execute(
            sql.SQL("""
                SELECT child.id
                FROM {} AS child
                LEFT JOIN {} AS parent ON child.{} = parent.id
                WHERE parent.id IS NULL
                ORDER BY child.id
                LIMIT 1
            """).format(source_table(child), source_table(parent), sql.Identifier(column))
        ).fetchone()
        if missing_parent:
            raise MigrationError(
                f"源表 {child} 的 id={missing_parent[0]} 有无效引用，"
                f"{column} 指向的 {parent} 记录不存在"
            )


def insert_and_verify(target, table, columns):
    stage = source_table(table)
    destination = target_table(table)
    names = sql.SQL(", ").join(map(sql.Identifier, columns))
    target.execute(
        sql.SQL("""
            INSERT INTO {} ({})
            SELECT {} FROM {}
            ON CONFLICT (id) DO NOTHING
        """).format(destination, names, names, stage)
    )
    inserted = target.rowcount

    source_values = sql.SQL(", ").join(sql.Identifier("src", column) for column in columns)
    target_values = sql.SQL(", ").join(sql.Identifier("dst", column) for column in columns)
    mismatch = target.execute(
        sql.SQL("""
            SELECT src.id
            FROM {} AS src
            LEFT JOIN {} AS dst ON dst.id = src.id
            WHERE dst.id IS NULL OR ROW({}) IS DISTINCT FROM ROW({})
            ORDER BY src.id
            LIMIT 1
        """).format(stage, destination, source_values, target_values)
    ).fetchone()
    if mismatch:
        raise MigrationError(f"{table} 的 id={mismatch[0]} 在目标库缺失或字段内容不同")

    source_total, target_total = target.execute(
        sql.SQL("SELECT (SELECT COUNT(*) FROM {}), (SELECT COUNT(*) FROM {})").format(
            stage, destination,
        )
    ).fetchone()
    return source_total, target_total, inserted


def migrate(mysql_settings, pg_settings):
    with pymysql.connect(**mysql_settings, charset="utf8mb4", connect_timeout=10) as source:
        start_source_snapshot(source)
        with psycopg.connect(**pg_settings, connect_timeout=10) as destination:
            with destination.cursor() as target:
                # 校验和写入期间阻止目标表被并发修改，普通读取仍可继续。
                target.execute(
                    sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(
                        sql.SQL(", ").join(map(target_table, TABLE_COLUMNS))
                    )
                )
                for table, columns in TABLE_COLUMNS.items():
                    copy_source(source, target, table, columns)
                verify_references(target)
                return {
                    table: insert_and_verify(target, table, columns)
                    for table, columns in TABLE_COLUMNS.items()
                }


def main():
    argparse.ArgumentParser(
        description="把 MySQL 用户、应用和对话历史迁入已初始化的 Java PostgreSQL 数据库。",
        epilog=(
            "先执行同目录下的 01_init_java_db.sql。"
            "分别设置 MYSQL_* 和 JAVA_PG_* 下的 HOST、PORT、USER、PASSWORD、DATABASE。"
            "同 ID 同内容可重跑，遇到冲突整批回滚。"
        ),
    ).parse_args()
    try:
        report = migrate(
            connection_settings("MYSQL", "database"),
            connection_settings("JAVA_PG", "dbname"),
        )
    except MigrationError as error:
        print(f"迁移失败，目标库未提交。{error}", file=sys.stderr)
        return 1
    except pymysql.MySQLError as error:
        code = error.args[0] if error.args and isinstance(error.args[0], int) else "未知"
        print(f"MySQL 读取失败（错误码 {code}），目标库未提交。", file=sys.stderr)
        return 1
    except psycopg.Error as error:
        detail = error.diag.constraint_name or error.diag.table_name
        context = f"，约束或表 {detail}" if detail else ""
        print(
            f"PostgreSQL 迁移失败（{type(error).__name__}，SQLSTATE "
            f"{error.sqlstate or '未知'}{context}）。",
            file=sys.stderr,
        )
        return 1

    for table, (source_total, target_total, inserted) in report.items():
        print(
            f"{table}  MySQL {source_total} 行，PostgreSQL {target_total} 行，"
            f"本次新增 {inserted} 行，目标库独有 {target_total - source_total} 行"
        )
    print("原主键和全部字段一致（含账号和部署标识），应用及消息归属校验通过。")
    print("消息内容和时间一致，按应用、创建时间和原消息 ID 排序的源消息顺序一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
