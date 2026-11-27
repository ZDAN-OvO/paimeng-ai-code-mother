import asyncio

import httpx
import pytest
from redis.exceptions import ConnectionError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db.history_repository import CONTEXT_MESSAGE_LIMIT, HistoryRepository
from app.history import HistoryService
from app.main import create_app

pytestmark = pytest.mark.integration


async def test_database_transaction_fronts_atomic_redis_append(service):
    before = await service.load_context(123)
    assert before.version == 0
    assert before.messages == []

    first = await service.append(123, 456, "user", "你好", task_id=789)
    assert await service.repository.version(123) == 1
    assert await service.memory.redis.lindex(service.memory.key(123), 0) == "1"
    assert (await service.memory.observe(123)).messages == [first]

    async with service.repository.engine.begin() as connection:
        await connection.execute(text("ALTER TABLE chat_sessions ADD CHECK (version < 2)"))
    with pytest.raises(IntegrityError):
        await service.append(123, 456, "ai", "事务会回滚", task_id=789)
    assert await service.repository.version(123) == 1
    assert (await service.repository.snapshot(123)).messages == [first]
    assert (await service.memory.observe(123)).messages == [first]


async def test_cache_keeps_the_same_latest_window_as_pg(service):
    await service.load_context(123)
    written = []
    for index in range(CONTEXT_MESSAGE_LIMIT + 2):
        written.append(await service.append(123, 456, "user", f"消息 {index}"))
    expected = written[-CONTEXT_MESSAGE_LIMIT:]

    cached = await service.memory.observe(123)
    assert cached.version == str(len(written))
    assert cached.messages == expected
    assert (await service.repository.snapshot(123)).messages == expected

    await service.memory.redis.delete(service.memory.key(123))
    assert (await service.load_context(123)).messages == expected
    assert (await service.memory.observe(123)).messages == expected


@pytest.mark.parametrize("new_first", [True, False], ids=["new_then_old", "old_then_new"])
async def test_same_pg_snapshot_and_concurrent_cache_rebuild_order(service, new_first, monkeypatch):
    for index in range(10):
        await service.repository.append(123, 456, "user", f"消息 {index + 1}")

    read_version = asyncio.Event()
    release_snapshot = asyncio.Event()
    old_repository = HistoryRepository(service.repository.engine)
    old_service = HistoryService(old_repository, service.memory)
    original_read_version = old_repository._read_version

    async def pause_after_read(connection, app_id):
        version = await original_read_version(connection, app_id)
        assert version == 10
        read_version.set()
        await release_snapshot.wait()
        return version

    monkeypatch.setattr(old_repository, "_read_version", pause_after_read)
    old_task = asyncio.create_task(old_service.load_context(123))
    try:
        await asyncio.wait_for(read_version.wait(), timeout=5)
        added = await service.append(123, 456, "ai", "消息 11")
        observed_by_new = await service.memory.observe(123)
        assert observed_by_new.version is None
        new_snapshot = await service.repository.snapshot(123)
        assert new_snapshot.version == 11
        assert new_snapshot.messages[-1] == added

        if new_first:
            assert await service.memory.rebuild(123, observed_by_new, new_snapshot)
            release_snapshot.set()
            old_snapshot = await asyncio.wait_for(old_task, timeout=5)
        else:
            release_snapshot.set()
            old_snapshot = await asyncio.wait_for(old_task, timeout=5)
            assert (await service.memory.observe(123)).version == "10"
            assert await service.memory.rebuild(123, observed_by_new, new_snapshot)
    finally:
        if not old_task.done():
            old_task.cancel()
            await asyncio.gather(old_task, return_exceptions=True)

    assert old_snapshot.version == 10
    assert len(old_snapshot.messages) == 10
    assert new_snapshot.messages[:-1] == old_snapshot.messages
    cached = await service.memory.observe(123)
    assert cached.version == "11"
    assert cached.messages == new_snapshot.messages
    assert await service.load_context(123) == new_snapshot


async def test_pg_context_when_redis_unavailable(service, monkeypatch):
    async def unavailable(*args, **kwargs):
        raise ConnectionError("测试连接失败")

    monkeypatch.setattr(service.memory.redis, "eval", unavailable)
    monkeypatch.setattr(service.memory.redis, "lrange", unavailable)
    message = await service.append(123, 456, "user", "缓存断开时仍保存")
    snapshot = await service.load_context(123)
    assert snapshot.version == 1
    assert snapshot.messages == [message]


async def test_history_api_same_second_cursor_filters_idempotency_and_delete(service, settings):
    async with service.repository.engine.begin() as connection:
        await connection.execute(text("INSERT INTO chat_sessions (app_id, version) VALUES (123, 11)"))
        await connection.execute(text("""
            INSERT INTO chat_messages (app_id, user_id, message_type, message, created_at, updated_at)
            SELECT 123, 456, 'ai', '消息 ' || n, '2026-11-25 21:32:01', '2026-11-25 21:32:01'
            FROM generate_series(1, 11) AS n
        """))

    app = create_app(settings)
    app.state.history = service
    app.state.settings = settings
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"X-Internal-Token": settings.internal_api_token.get_secret_value()},
    ) as client:
        path = "/internal/v1/apps/123/messages"
        first = (await client.get(path)).json()
        assert first["totalRow"] == 11
        assert [row["id"] for row in first["records"]] == [str(number) for number in range(11, 1, -1)]
        last = first["records"][-1]
        after = {"lastCreateTime": last["createTime"], "lastId": last["id"]}
        second = (await client.get(path, params=after)).json()
        assert second["totalRow"] == 11
        assert [row["id"] for row in second["records"]] == ["1"]
        old_cursor = (await client.get(path, params={"lastCreateTime": last["createTime"]})).json()
        assert old_cursor["records"] == []

        admin = "/internal/v1/admin/messages/page"
        filters = {"messageType": "assistant", "userId": "456", "appId": "123", "message": "消息"}
        admin_first = (await client.post(admin, json=filters)).json()
        assert admin_first == first
        admin_second = (await client.post(admin, json={**filters, "pageNum": 2})).json()
        assert admin_second == second

        body = {"userId": "456", "messageType": "ai", "message": "生成结果", "taskId": "789"}
        saved, repeated = await asyncio.gather(client.post(path, json=body), client.post(path, json=body))
        assert saved.status_code == repeated.status_code == 200
        assert saved.json() == repeated.json()
        assert await service.repository.version(123) == 12
        assert (await client.post(path, json={**body, "message": "冲突结果"})).status_code == 409

        assert (await service.load_context(123)).version == 12
        assert (await client.delete("/internal/v1/apps/123/history")).status_code == 204
        assert (await client.delete("/internal/v1/apps/123/history")).status_code == 204
        assert (await client.get(path)).json() == {"records": [], "totalRow": 0}
        assert (await client.post(admin, json=filters)).json() == {"records": [], "totalRow": 0}
        assert (await client.post(path, json=body)).status_code == 410
        assert (await service.load_context(123)).messages == []
        assert (await service.memory.observe(123)).version == "13"
