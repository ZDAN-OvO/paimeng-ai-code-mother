from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def create_engine(url: URL) -> AsyncEngine:
    return create_async_engine(
        url,
        pool_pre_ping=True,
        hide_parameters=True,
        connect_args={"timeout": 5},
    )
