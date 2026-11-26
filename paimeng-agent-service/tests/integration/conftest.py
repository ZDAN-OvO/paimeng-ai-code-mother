import os
from functools import partial
from pathlib import Path
from uuid import uuid4

import asyncpg
import psycopg
import pytest
from psycopg import sql
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.history_repository import HistoryRepository
from app.history import HistoryService
from app.memory.versioned_redis_memory import VersionedRedisMemory

SQL_ROOT = Path(__file__).resolve().parents[3] / "sql" / "pg"


@pytest.fixture
def postgres_schemas():
    dsn = os.getenv("PAIMENG_TEST_PG_DSN")
    if not dsn:
        pytest.skip("需要配置独立测试库 PAIMENG_TEST_PG_DSN")
    target = f"history_test_{uuid4().hex}"
    source = f"java_test_{uuid4().hex}"
    with psycopg.connect(dsn, autocommit=True) as admin:
        try:
            for name in (target, source):
                admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
            admin.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(target)))
            ddl = (SQL_ROOT / "02_init_python_history_db.sql").read_text(encoding="utf-8")
            admin.execute(ddl)
            admin.execute(ddl)
            yield dsn, target, source
        finally:
            for name in (target, source):
                admin.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(name)))


@pytest.fixture
async def repository(postgres_schemas):
    dsn, target, _source = postgres_schemas
    engine = create_async_engine(
        "postgresql+asyncpg://",
        async_creator=partial(asyncpg.connect, dsn, server_settings={"search_path": target}),
    )
    try:
        yield HistoryRepository(engine)
    finally:
        await engine.dispose()


@pytest.fixture
async def service(repository):
    redis_url = os.getenv("PAIMENG_TEST_REDIS_URL")
    if not redis_url:
        pytest.skip("需要配置独立测试 Redis PAIMENG_TEST_REDIS_URL")
    prefix = f"history_test:{uuid4().hex}:"
    async with Redis.from_url(redis_url, decode_responses=True) as redis:
        await redis.ping()
        try:
            yield HistoryService(repository, VersionedRedisMemory(redis, key_prefix=prefix))
        finally:
            async for key in redis.scan_iter(match=f"{prefix}*"):
                await redis.delete(key)
