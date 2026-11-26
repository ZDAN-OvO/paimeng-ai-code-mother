from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, BeforeValidator, Field, StringConstraints

from app.api.dependencies import HistoryDependency, require_internal_token
from app.db.history_repository import HistoryDeleted, HistoryPage, MessageConflict
from app.db.models import HistoryMessage, MessageType

router = APIRouter(prefix="/internal/v1", dependencies=[Depends(require_internal_token)])

MAX_BIGINT = 2**63 - 1
MAX_JAVA_INT = 2**31 - 1
ID = Annotated[int, Field(gt=0, le=MAX_BIGINT)]
AppID = Annotated[int, Path(gt=0, le=MAX_BIGINT)]
InputMessageType = Literal["user", "ai", "assistant"]
SortField = Literal["id", "appId", "userId", "messageType", "message", "createTime", "updateTime"]


def _parse_cursor_time(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("时间必须为 yyyy-MM-ddTHH:mm:ss")
    parsed = datetime.fromisoformat(value)
    if value != parsed.isoformat(timespec="seconds") or parsed.tzinfo is not None:
        raise ValueError("时间必须为 yyyy-MM-ddTHH:mm:ss")
    return parsed


CursorTime = Annotated[datetime, BeforeValidator(_parse_cursor_time)]


def _canonical_message_type(message_type: InputMessageType) -> MessageType:
    return "ai" if message_type == "assistant" else message_type


class MessageBody(BaseModel):
    userId: ID
    messageType: InputMessageType
    message: Annotated[str, StringConstraints(min_length=1, pattern=r"\S")]
    taskId: ID | UUID | None = None


class AdminPageRequest(BaseModel):
    pageNum: int = Field(default=1, ge=1, le=MAX_JAVA_INT)
    pageSize: int = Field(default=10, ge=1, le=MAX_JAVA_INT)
    id: ID | None = None
    appId: ID | None = None
    userId: ID | None = None
    messageType: InputMessageType | None = None
    message: str | None = None
    lastCreateTime: CursorTime | None = None
    sortField: SortField | None = None
    sortOrder: Literal["ascend", "descend"] | None = None


class MessageRecord(BaseModel):
    id: str
    appId: str
    userId: str
    messageType: MessageType
    message: str
    createTime: str
    updateTime: str
    isDelete: int

    @classmethod
    def from_history(cls, message: HistoryMessage) -> "MessageRecord":
        return cls(
            id=str(message.id),
            appId=str(message.app_id),
            userId=str(message.user_id),
            messageType=message.message_type,
            message=message.message,
            createTime=message.created_at.isoformat(timespec="seconds"),
            updateTime=message.updated_at.isoformat(timespec="seconds"),
            isDelete=int(message.is_deleted),
        )


class PageResponse(BaseModel):
    records: list[MessageRecord]
    totalRow: int

    @classmethod
    def from_page(cls, page: HistoryPage) -> "PageResponse":
        return cls(records=[MessageRecord.from_history(row) for row in page.records], totalRow=page.total)


@router.get("/apps/{app_id}/messages")
async def list_app_messages(
    app_id: AppID,
    history: HistoryDependency,
    pageSize: Annotated[int, Query(ge=1, le=50)] = 10,
    lastCreateTime: CursorTime | None = None,
    lastId: Annotated[int | None, Query(gt=0, le=MAX_BIGINT)] = None,
) -> PageResponse:
    if lastId is not None and lastCreateTime is None:
        raise HTTPException(status_code=422, detail="lastId 需要与 lastCreateTime 同时使用")
    page = await history.repository.app_page(app_id, pageSize, lastCreateTime, lastId)
    return PageResponse.from_page(page)


@router.post("/apps/{app_id}/messages")
async def write_app_message(app_id: AppID, body: MessageBody, history: HistoryDependency) -> MessageRecord:
    try:
        if isinstance(body.taskId, UUID):
            if body.messageType != "user":
                raise HTTPException(status_code=422, detail="UUID 任务只允许通过此接口补登记用户消息")
            message = await history.register_generation_user(app_id, body.userId, body.taskId, body.message)
        else:
            message = await history.append(
                app_id, body.userId, _canonical_message_type(body.messageType), body.message, body.taskId
            )
    except HistoryDeleted as exc:
        raise HTTPException(status_code=410, detail="应用历史已删除") from exc
    except MessageConflict as exc:
        raise HTTPException(status_code=409, detail="同一任务的已保存消息内容不一致") from exc
    return MessageRecord.from_history(message)


@router.post("/admin/messages/page")
async def list_admin_messages(body: AdminPageRequest, history: HistoryDependency) -> PageResponse:
    message_type = _canonical_message_type(body.messageType) if body.messageType is not None else None
    page = await history.repository.admin_page(
        page=body.pageNum,
        page_size=body.pageSize,
        message_id=body.id,
        app_id=body.appId,
        user_id=body.userId,
        message_type=message_type,
        message=body.message,
        before=body.lastCreateTime,
        sort_field=body.sortField or "createTime",
        ascending=body.sortOrder == "ascend",
    )
    return PageResponse.from_page(page)


@router.delete("/apps/{app_id}/history", status_code=204)
async def delete_app_history(app_id: AppID, history: HistoryDependency) -> Response:
    await history.delete(app_id)
    return Response(status_code=204)
