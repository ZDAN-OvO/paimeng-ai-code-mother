from hmac import compare_digest
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from app.history import HistoryService
from app.routing.type_router import TypeRouter


async def require_internal_token(
    request: Request, token: Annotated[str | None, Header(alias="X-Internal-Token")] = None
) -> None:
    expected = request.app.state.settings.internal_api_token.get_secret_value()
    if token is None or not compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="内部服务令牌无效")


async def get_history(request: Request) -> HistoryService:
    return request.app.state.history


async def get_type_router(request: Request) -> TypeRouter:
    return request.app.state.type_router


HistoryDependency = Annotated[HistoryService, Depends(get_history)]
RouterDependency = Annotated[TypeRouter, Depends(get_type_router)]
