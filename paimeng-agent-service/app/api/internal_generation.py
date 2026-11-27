import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, JsonValue, StringConstraints, field_validator

from app.agent.runner import GenerationEvent, GenerationRun, GenerationRunner
from app.api.dependencies import HistoryDependency, require_internal_token
from app.api.internal_history import MAX_BIGINT, AppID, MessageRecord
from app.db.history_repository import GenerationTaskNotFound, HistoryDeleted, MessageConflict
from app.db.models import GenerationStatus
from app.history import HistoryService
from app.routing.type_router import CodeGenType

router = APIRouter(prefix="/internal/v1", dependencies=[Depends(require_internal_token)])
StringID = Annotated[str, StringConstraints(strict=True, pattern=r"^[1-9][0-9]{0,18}$")]


class GenerationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    appId: StringID
    userId: StringID
    taskId: UUID
    codeGenType: CodeGenType
    message: str

    @field_validator("appId", "userId")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if int(value) > MAX_BIGINT:
            raise ValueError("ID 超出范围")
        return value

    @field_validator("message")
    @classmethod
    def validate_message_encoding(cls, value: str) -> str:
        return _pg_text(value)


class CommitBody(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    taskId: UUID
    status: GenerationStatus
    content: str
    buildResult: dict[str, JsonValue] | None

    @field_validator("content")
    @classmethod
    def validate_content_encoding(cls, value: str) -> str:
        return _pg_text(value)

    @field_validator("buildResult")
    @classmethod
    def validate_build_result(cls, value: dict | None) -> dict | None:
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, str):
                _pg_text(item)
        json.dumps(value, allow_nan=False)
        return value


def _pg_text(value: str) -> str:
    value.encode("utf-8")
    if "\x00" in value:
        raise ValueError("文本不能包含空字符")
    return value


def _sse(event: GenerationEvent) -> str:
    payload = json.dumps(event.data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event.type}\ndata: {payload}\n\n"


async def _stream(runner: GenerationRunner, run: GenerationRun, history: HistoryService) -> AsyncIterator[str]:
    async with aclosing(runner.events(run, history)) as events:
        async for event in events:
            yield _sse(event)


@router.post("/generation/runs")
async def run_generation(body: GenerationBody, request: Request, history: HistoryDependency) -> StreamingResponse:
    app_id = int(body.appId)
    try:
        user_message = await history.start_generation(app_id, int(body.userId), body.taskId, body.message)
    except HistoryDeleted as exc:
        raise HTTPException(status_code=410, detail="应用历史已删除") from exc
    except MessageConflict as exc:
        raise HTTPException(status_code=409, detail="此生成任务已受理") from exc

    run = GenerationRun(app_id, body.taskId, body.codeGenType, user_message)
    return StreamingResponse(
        _stream(request.app.state.generation, run, history),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/apps/{app_id}/messages/commit-result")
async def commit_result(app_id: AppID, body: CommitBody, history: HistoryDependency) -> MessageRecord:
    try:
        message = await history.commit_generation_result(app_id, body.taskId, body.status, body.content, body.buildResult)
    except HistoryDeleted as exc:
        raise HTTPException(status_code=410, detail="应用历史已删除") from exc
    except GenerationTaskNotFound as exc:
        raise HTTPException(status_code=404, detail="生成任务对应的用户消息不存在") from exc
    except MessageConflict as exc:
        raise HTTPException(status_code=409, detail="此任务的已提交结果不一致") from exc
    return MessageRecord.from_history(message)
