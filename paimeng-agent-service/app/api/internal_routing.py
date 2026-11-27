import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from openai import APIError
from pydantic import BaseModel, StringConstraints

from app.api.dependencies import RouterDependency, require_internal_token
from app.routing.type_router import CodeGenType, InvalidRouteOutput

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/v1", dependencies=[Depends(require_internal_token)])


class RouteRequest(BaseModel):
    initPrompt: Annotated[str, StringConstraints(min_length=1, pattern=r"\S")]


class RouteResponse(BaseModel):
    codeGenType: CodeGenType


@router.post("/routing/code-gen-type")
async def route_code_gen_type(body: RouteRequest, type_router: RouterDependency) -> RouteResponse:
    try:
        return RouteResponse(codeGenType=await type_router.route(body.initPrompt))
    except InvalidRouteOutput as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (APIError, ValueError) as exc:
        logger.warning("路由模型请求失败，错误类型=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="路由模型暂不可用") from exc
