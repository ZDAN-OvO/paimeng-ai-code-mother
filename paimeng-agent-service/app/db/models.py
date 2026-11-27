from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import BigInteger, Boolean, ForeignKey, Identity, String, Text, Uuid, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

MessageType = Literal["user", "ai"]
GenerationStatus = Literal["success", "failed"]

SHANGHAI_NOW = text("date_trunc('second', statement_timestamp() AT TIME ZONE 'Asia/Shanghai')")


class Base(DeclarativeBase):
    pass


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    app_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    is_deleted: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    app_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.app_id"))
    user_id: Mapped[int] = mapped_column(BigInteger)
    task_id: Mapped[int | None] = mapped_column(BigInteger)
    message_type: Mapped[MessageType] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(precision=0), server_default=SHANGHAI_NOW)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(precision=0), server_default=SHANGHAI_NOW)
    is_deleted: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class GenerationMessageTask(Base):
    __tablename__ = "generation_message_tasks"

    app_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.app_id"), primary_key=True, autoincrement=False)
    task_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    user_message_id: Mapped[int] = mapped_column(ForeignKey("chat_messages.id"), unique=True)
    result_message_id: Mapped[int | None] = mapped_column(ForeignKey("chat_messages.id"), unique=True)
    status: Mapped[GenerationStatus | None] = mapped_column(String(8))
    build_result: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))


class HistoryMessage(BaseModel):
    id: int
    app_id: int
    user_id: int
    message_type: MessageType
    message: str
    created_at: datetime
    updated_at: datetime
    is_deleted: bool
