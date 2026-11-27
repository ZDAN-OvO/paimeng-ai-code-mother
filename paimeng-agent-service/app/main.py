from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.agent.responses import ResponsesModel
from app.agent.runner import GenerationRunner
from app.api import internal_generation, internal_history, internal_routing
from app.config import Settings
from app.db.connection import create_engine
from app.db.history_repository import HistoryRepository
from app.history import HistoryService
from app.memory.versioned_redis_memory import VersionedRedisMemory
from app.model import build_responses_model
from app.routing.type_router import TypeRouter


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        config = settings or Settings()
        application.state.settings = config
        model = build_responses_model(config)
        application.state.type_router = TypeRouter(model)
        application.state.generation = GenerationRunner(
            ResponsesModel(model), config.paimeng_workspace_root, config.generation_context_tokens
        )
        engine = create_engine(config.postgres_url)
        try:
            async with Redis.from_url(
                config.memory_redis_url,
                decode_responses=True,
                socket_connect_timeout=0.5,
                socket_timeout=0.5,
                retry=Retry(NoBackoff(), 0),
            ) as redis:
                application.state.history = HistoryService(HistoryRepository(engine), VersionedRedisMemory(redis))
                yield
        finally:
            await engine.dispose()

    application = FastAPI(title="Paimeng Agent Service", lifespan=lifespan)
    application.include_router(internal_history.router)
    application.include_router(internal_routing.router)
    application.include_router(internal_generation.router)

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return application


app = create_app()
