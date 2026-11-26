from unittest.mock import AsyncMock

import pytest
from redis.exceptions import ConnectionError

from app.db.history_repository import HistoryRepository, HistorySnapshot, MessageWrite
from app.history import HistoryService
from app.memory.versioned_redis_memory import CacheState, VersionedRedisMemory


@pytest.fixture
def service():
    return HistoryService(AsyncMock(spec=HistoryRepository), AsyncMock(spec=VersionedRedisMemory))


async def test_cached_context_requires_current_postgres_version(service, make_message):
    records = [make_message(1), make_message(2)]
    service.repository.version.return_value = 2
    service.memory.observe.return_value = CacheState("2", records)

    assert await service.load_context(123) == HistorySnapshot(2, records)
    service.repository.snapshot.assert_not_awaited()
    service.memory.rebuild.assert_not_awaited()


@pytest.mark.parametrize("version", [None, "1", "3"])
async def test_cache_miss_or_mismatch_uses_one_snapshot(service, make_message, version):
    snapshot = HistorySnapshot(2, [make_message(1), make_message(2)])
    observed = CacheState(version, [] if version is not None else None)
    service.repository.version.return_value = 2
    service.repository.snapshot.return_value = snapshot
    service.memory.observe.return_value = observed

    assert await service.load_context(123) == snapshot
    service.repository.snapshot.assert_awaited_once_with(123)
    service.memory.rebuild.assert_awaited_once_with(123, observed, snapshot)


@pytest.mark.parametrize("operation", ["observe", "rebuild"])
async def test_redis_failure_uses_pg_snapshot(service, make_message, operation):
    snapshot = HistorySnapshot(1, [make_message(1)])
    service.repository.snapshot.return_value = snapshot
    service.memory.observe.return_value = CacheState(None, None)
    getattr(service.memory, operation).side_effect = ConnectionError

    assert await service.load_context(123) == snapshot
    service.repository.snapshot.assert_awaited_once_with(123)


async def test_cache_append_failure_preserves_committed_message(service, make_message):
    message = make_message(2, "ai")
    service.repository.append.return_value = MessageWrite(message, previous_version=1, version=2)
    service.memory.append.side_effect = ConnectionError

    assert await service.append(123, 456, "ai", message.message, 789) == message
    service.repository.append.assert_awaited_once_with(123, 456, "ai", message.message, 789)
    service.memory.append.assert_awaited_once_with(123, 1, 2, message)


async def test_task_retry_does_not_append_to_cache_twice(service, make_message):
    message = make_message(2, "ai")
    service.repository.append.return_value = MessageWrite(message, previous_version=None, version=2)

    assert await service.append(123, 456, "ai", message.message, 789) == message
    service.memory.append.assert_not_awaited()
