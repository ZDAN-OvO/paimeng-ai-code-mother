from dataclasses import dataclass

from pydantic import ValidationError
from redis.asyncio import Redis

from app.db.history_repository import CONTEXT_MESSAGE_LIMIT, HistorySnapshot
from app.db.models import HistoryMessage

# 版本可能超过 Lua 浮点数的精确整数范围，用十进制字符串比较。
APPEND = """
local current = redis.call('LINDEX', KEYS[1], 0)
if current ~= ARGV[1] then return 0 end

local tail = redis.call('LINDEX', KEYS[1], -1)
if tail ~= current and string.sub(tail, 1, 39) >= string.sub(ARGV[3], 1, 39) then
    return 0
end

redis.call('RPUSH', KEYS[1], ARGV[3])
if redis.call('LLEN', KEYS[1]) > tonumber(ARGV[4]) + 1 then
    -- 先弹出版本头，保留下来的列表头会被替换为新版本。
    redis.call('LPOP', KEYS[1])
end
redis.call('LSET', KEYS[1], 0, ARGV[2])
return 1
"""

REBUILD = """
local function greater(left, right)
    return #left > #right or (#left == #right and left > right)
end

local current = redis.call('LINDEX', KEYS[1], 0) or ''
local observed = ARGV[1]
local snapshot = ARGV[2]
if current ~= '' and greater(current, snapshot) then return 0 end
if current ~= observed and (current == '' or not greater(snapshot, current)) then return 0 end

redis.call('DEL', KEYS[1])
redis.call('RPUSH', KEYS[1], unpack(ARGV, 2))
return 1
"""


@dataclass(frozen=True)
class CacheState:
    version: str | None
    messages: list[HistoryMessage] | None


def _encode(message: HistoryMessage) -> str:
    # 固定宽度的前缀与 PostgreSQL 按时间、ID 排序的结果一致。
    created_at = message.created_at.isoformat(timespec="seconds")
    return f"{created_at}|{message.id:019d}|{message.model_dump_json()}"


class VersionedRedisMemory:
    def __init__(self, redis: Redis, key_prefix: str = "paimeng:history:v1:"):
        self.redis = redis
        self.key_prefix = key_prefix

    def key(self, app_id: int) -> str:
        return f"{self.key_prefix}{app_id}"

    async def observe(self, app_id: int) -> CacheState:
        rows = await self.redis.lrange(self.key(app_id), 0, CONTEXT_MESSAGE_LIMIT)
        if not rows:
            return CacheState(None, None)
        version, *payloads = rows
        try:
            return CacheState(
                version,
                [HistoryMessage.model_validate_json(payload[40:]) for payload in payloads],
            )
        except ValidationError:
            return CacheState(version, None)

    async def append(
        self, app_id: int, previous_version: int, version: int, message: HistoryMessage
    ) -> bool:
        return bool(await self.redis.eval(
            APPEND, 1, self.key(app_id),
            str(previous_version), str(version), _encode(message), CONTEXT_MESSAGE_LIMIT,
        ))

    async def rebuild(self, app_id: int, observed: CacheState, snapshot: HistorySnapshot) -> bool:
        return bool(await self.redis.eval(
            REBUILD, 1, self.key(app_id),
            observed.version or "", str(snapshot.version),
            *(_encode(message) for message in snapshot.messages),
        ))
