import logging
from uuid import UUID

from redis.exceptions import RedisError

from app.db.history_repository import HistoryRepository, HistorySnapshot, MessageWrite
from app.db.models import GenerationStatus, HistoryMessage, MessageType
from app.memory.versioned_redis_memory import VersionedRedisMemory

logger = logging.getLogger(__name__)


class HistoryService:
    def __init__(self, repository: HistoryRepository, memory: VersionedRedisMemory):
        self.repository = repository
        self.memory = memory

    async def append(
        self,
        app_id: int,
        user_id: int,
        message_type: MessageType,
        message: str,
        task_id: int | None = None,
    ) -> HistoryMessage:
        result = await self.repository.append(app_id, user_id, message_type, message, task_id)
        return await self._cache_write(app_id, result)

    async def start_generation(self, app_id: int, user_id: int, task_id: UUID, content: str) -> HistoryMessage:
        return await self._cache_write(app_id, await self.repository.start_generation(app_id, user_id, task_id, content))

    async def register_generation_user(self, app_id: int, user_id: int, task_id: UUID, content: str) -> HistoryMessage:
        result = await self.repository.start_generation(app_id, user_id, task_id, content, allow_existing=True)
        return await self._cache_write(app_id, result)

    async def commit_generation_result(
        self, app_id: int, task_id: UUID, status: GenerationStatus, content: str, build_result: dict | None
    ) -> HistoryMessage:
        result = await self.repository.commit_generation_result(app_id, task_id, status, content, build_result)
        return await self._cache_write(app_id, result)

    async def _cache_write(self, app_id: int, result: MessageWrite) -> HistoryMessage:
        if result.previous_version is not None:
            try:
                await self.memory.append(app_id, result.previous_version, result.version, result.message)
            except RedisError:
                logger.warning("对话缓存追加失败，appId=%d", app_id)
        return result.message

    async def load_context(self, app_id: int) -> HistorySnapshot:
        try:
            observed = await self.memory.observe(app_id)
        except RedisError:
            logger.warning("对话缓存读取失败，appId=%d", app_id)
            return await self.repository.snapshot(app_id)

        if observed.messages is not None and observed.version is not None:
            version = await self.repository.version(app_id)
            if observed.version == str(version):
                return HistorySnapshot(version, observed.messages)

        snapshot = await self.repository.snapshot(app_id)
        try:
            await self.memory.rebuild(app_id, observed, snapshot)
        except RedisError:
            logger.warning("对话缓存重建失败，appId=%d", app_id)
        return snapshot

    async def delete(self, app_id: int) -> None:
        version = await self.repository.delete(app_id)
        try:
            observed = await self.memory.observe(app_id)
            await self.memory.rebuild(app_id, observed, HistorySnapshot(version, []))
        except RedisError:
            logger.warning("对话缓存清理失败，appId=%d", app_id)
