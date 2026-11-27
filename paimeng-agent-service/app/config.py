from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    python_pg_host: str = "127.0.0.1"
    python_pg_port: int = 5432
    python_pg_database: str = "paimeng_agent"
    python_pg_user: str = Field(min_length=1)
    python_pg_password: SecretStr
    memory_redis_url: str = "redis://127.0.0.1:6379/1"

    model_base_url: str = Field(min_length=1)
    model_name: str = Field(min_length=1)
    model_api_key: SecretStr
    paimeng_workspace_root: Path | None = None
    generation_context_tokens: int = Field(default=16_000, ge=1_000)
    internal_api_token: SecretStr

    @field_validator("python_pg_password", "model_api_key", "internal_api_token")
    @classmethod
    def require_secret(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("配置不能为空")
        return value

    @property
    def postgres_url(self) -> URL:
        return URL.create(
            "postgresql+asyncpg",
            username=self.python_pg_user,
            password=self.python_pg_password.get_secret_value(),
            host=self.python_pg_host,
            port=self.python_pg_port,
            database=self.python_pg_database,
        )
