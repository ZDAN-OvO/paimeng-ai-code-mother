from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, func, insert, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.db.models import (
    ChatMessage, ChatSession, GenerationMessageTask, GenerationStatus, HistoryMessage, MessageType, SHANGHAI_NOW,
)

CONTEXT_MESSAGE_LIMIT = 20

MESSAGES = ChatMessage.__table__
SESSIONS = ChatSession.__table__
GENERATION_TASKS = GenerationMessageTask.__table__
VISIBLE = ChatMessage.is_deleted.is_(False)
SORT_COLUMNS = {
    "id": ChatMessage.id,
    "appId": ChatMessage.app_id,
    "userId": ChatMessage.user_id,
    "messageType": ChatMessage.message_type,
    "message": ChatMessage.message,
    "createTime": ChatMessage.created_at,
    "updateTime": ChatMessage.updated_at,
}


class HistoryDeleted(Exception):
    pass


class MessageConflict(Exception):
    pass


class GenerationTaskNotFound(Exception):
    pass


@dataclass(frozen=True)
class HistoryPage:
    records: list[HistoryMessage]
    total: int


@dataclass(frozen=True)
class HistorySnapshot:
    version: int
    messages: list[HistoryMessage]


@dataclass(frozen=True)
class MessageWrite:
    message: HistoryMessage
    previous_version: int | None
    version: int


async def _lock_session(connection: AsyncConnection, app_id: int):
    await connection.execute(
        pg_insert(SESSIONS).values(app_id=app_id).on_conflict_do_nothing()
    )
    return (
        await connection.execute(select(SESSIONS).where(SESSIONS.c.app_id == app_id).with_for_update())
    ).mappings().one()


def _cursor(before: datetime, before_id: int | None) -> ColumnElement[bool]:
    if before_id is None:
        return ChatMessage.created_at < before
    return tuple_(ChatMessage.created_at, ChatMessage.id) < tuple_(before, before_id)


async def _insert_message(
    connection: AsyncConnection,
    previous_version: int,
    app_id: int,
    user_id: int,
    message_type: MessageType,
    message: str,
    task_id: int | None = None,
) -> MessageWrite:
    row = (
        await connection.execute(
            insert(MESSAGES).values(
                app_id=app_id, user_id=user_id, message_type=message_type, message=message, task_id=task_id,
            ).returning(MESSAGES)
        )
    ).mappings().one()
    version = previous_version + 1
    await connection.execute(update(SESSIONS).where(SESSIONS.c.app_id == app_id).values(version=version))
    return MessageWrite(HistoryMessage.model_validate(row), previous_version, version)


class HistoryRepository:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    async def append(
        self,
        app_id: int,
        user_id: int,
        message_type: MessageType,
        message: str,
        task_id: int | None = None,
    ) -> MessageWrite:
        async with self.engine.begin() as connection:
            session = await _lock_session(connection, app_id)
            if session["is_deleted"]:
                raise HistoryDeleted

            previous_version = session["version"]
            if task_id is not None:
                existing = (
                    await connection.execute(
                        select(MESSAGES).where(
                            MESSAGES.c.app_id == app_id,
                            MESSAGES.c.task_id == task_id,
                            MESSAGES.c.message_type == message_type,
                        )
                    )
                ).mappings().one_or_none()
                if existing is not None:
                    if existing["user_id"] != user_id or existing["message"] != message:
                        raise MessageConflict
                    return MessageWrite(HistoryMessage.model_validate(existing), None, previous_version)

            return await _insert_message(
                connection, previous_version, app_id, user_id, message_type, message, task_id
            )

    async def start_generation(
        self, app_id: int, user_id: int, task_id: UUID, content: str, *, allow_existing: bool = False
    ) -> MessageWrite:
        async with self.engine.begin() as connection:
            session = await _lock_session(connection, app_id)
            if session["is_deleted"]:
                raise HistoryDeleted
            if allow_existing:
                existing = (
                    await connection.execute(
                        select(MESSAGES)
                        .join(GENERATION_TASKS, GENERATION_TASKS.c.user_message_id == MESSAGES.c.id)
                        .where(GENERATION_TASKS.c.app_id == app_id, GENERATION_TASKS.c.task_id == task_id, VISIBLE)
                    )
                ).mappings().one_or_none()
                if existing is not None:
                    if existing["user_id"] != user_id or existing["message"] != content:
                        raise MessageConflict
                    return MessageWrite(HistoryMessage.model_validate(existing), None, session["version"])
            result = await _insert_message(connection, session["version"], app_id, user_id, "user", content)
            started = await connection.scalar(
                pg_insert(GENERATION_TASKS)
                .values(app_id=app_id, task_id=task_id, user_message_id=result.message.id)
                .on_conflict_do_nothing(index_elements=[GENERATION_TASKS.c.app_id, GENERATION_TASKS.c.task_id])
                .returning(GENERATION_TASKS.c.task_id)
            )
            if started is None:
                # 回滚上面的历史追加，避免同时进入同一个临时目录。
                raise MessageConflict
            return result

    async def commit_generation_result(
        self, app_id: int, task_id: UUID, status: GenerationStatus, content: str, build_result: dict | None
    ) -> MessageWrite:
        async with self.engine.begin() as connection:
            session = await _lock_session(connection, app_id)
            if session["is_deleted"]:
                raise HistoryDeleted
            task = (
                await connection.execute(
                    select(GENERATION_TASKS, MESSAGES.c.user_id)
                    .join(MESSAGES, GENERATION_TASKS.c.user_message_id == MESSAGES.c.id)
                    .where(GENERATION_TASKS.c.app_id == app_id, GENERATION_TASKS.c.task_id == task_id, VISIBLE)
                )
            ).mappings().one_or_none()
            if task is None:
                raise GenerationTaskNotFound

            if task["result_message_id"] is not None:
                existing = (
                    await connection.execute(select(MESSAGES).where(MESSAGES.c.id == task["result_message_id"]))
                ).mappings().one()
                # Python 中 True == 1，交给 JSONB 判断构建结果是否确实相同。
                same_build = await connection.scalar(
                    select(GENERATION_TASKS.c.build_result.is_not_distinct_from(build_result))
                    .where(GENERATION_TASKS.c.app_id == app_id, GENERATION_TASKS.c.task_id == task_id)
                )
                if existing["message"] != content or task["status"] != status or not same_build:
                    raise MessageConflict
                return MessageWrite(HistoryMessage.model_validate(existing), None, session["version"])

            result = await _insert_message(connection, session["version"], app_id, task["user_id"], "ai", content)
            await connection.execute(
                update(GENERATION_TASKS).where(
                    GENERATION_TASKS.c.app_id == app_id, GENERATION_TASKS.c.task_id == task_id,
                ).values(
                    result_message_id=result.message.id, status=status, build_result=build_result,
                )
            )
            return result

    async def version(self, app_id: int) -> int:
        async with self.engine.connect() as connection:
            return await self._read_version(connection, app_id)

    async def snapshot(self, app_id: int) -> HistorySnapshot:
        async with self.engine.begin() as connection:
            await connection.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            version = await self._read_version(connection, app_id)
            rows = (
                await connection.execute(
                    select(MESSAGES).where(ChatMessage.app_id == app_id, VISIBLE)
                    .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
                    .limit(CONTEXT_MESSAGE_LIMIT)
                )
            ).mappings().all()
            messages = [HistoryMessage.model_validate(row) for row in reversed(rows)]
            return HistorySnapshot(version, messages)

    async def _read_version(self, connection: AsyncConnection, app_id: int) -> int:
        version = await connection.scalar(select(ChatSession.version).where(ChatSession.app_id == app_id))
        return version if version is not None else 0

    async def app_page(
        self, app_id: int, page_size: int, before: datetime | None, before_id: int | None
    ) -> HistoryPage:
        filters = [VISIBLE, ChatMessage.app_id == app_id]
        cursor_filters = [] if before is None else [_cursor(before, before_id)]
        return await self._page(filters, cursor_filters, page_size, 0, "createTime", False)

    async def admin_page(
        self,
        *,
        page: int,
        page_size: int,
        message_id: int | None = None,
        app_id: int | None = None,
        user_id: int | None = None,
        message_type: MessageType | None = None,
        message: str | None = None,
        before: datetime | None = None,
        sort_field: str = "createTime",
        ascending: bool = False,
    ) -> HistoryPage:
        filters = [VISIBLE]
        for column, value in (
            (ChatMessage.id, message_id),
            (ChatMessage.app_id, app_id),
            (ChatMessage.user_id, user_id),
            (ChatMessage.message_type, message_type),
        ):
            if value is not None:
                filters.append(column == value)
        if message:
            filters.append(ChatMessage.message.icontains(message, autoescape=True))
        if before is not None:
            filters.append(_cursor(before, None))
        return await self._page(filters, [], page_size, (page - 1) * page_size, sort_field, ascending)

    async def _page(
        self,
        filters: list[ColumnElement[bool]],
        cursor_filters: list[ColumnElement[bool]],
        limit: int,
        offset: int,
        sort_field: str,
        ascending: bool,
    ) -> HistoryPage:
        column = SORT_COLUMNS[sort_field]
        order = [column.asc() if ascending else column.desc()]
        if sort_field != "id":
            order.append(ChatMessage.id.asc() if ascending else ChatMessage.id.desc())
        async with self.engine.begin() as connection:
            await connection.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            total = await connection.scalar(select(func.count()).select_from(MESSAGES).where(*filters))
            rows = (
                await connection.execute(
                    select(MESSAGES).where(*filters, *cursor_filters).order_by(*order).limit(limit).offset(offset)
                )
            ).mappings().all()
        return HistoryPage([HistoryMessage.model_validate(row) for row in rows], total)

    async def delete(self, app_id: int) -> int:
        async with self.engine.begin() as connection:
            session = await _lock_session(connection, app_id)
            if session["is_deleted"]:
                return session["version"]
            version = session["version"] + 1
            await connection.execute(
                update(MESSAGES).where(MESSAGES.c.app_id == app_id, VISIBLE)
                .values(is_deleted=True, updated_at=SHANGHAI_NOW)
            )
            await connection.execute(
                update(SESSIONS).where(SESSIONS.c.app_id == app_id)
                .values(is_deleted=True, version=version)
            )
            return version
