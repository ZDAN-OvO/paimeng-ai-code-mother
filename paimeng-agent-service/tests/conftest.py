from datetime import datetime
from typing import Literal

import pytest

from app.config import Settings
from app.db.models import HistoryMessage


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        python_pg_user="test_user",
        python_pg_password="test_password",
        model_base_url="http://gateway.test/v1",
        model_name="test-model",
        model_api_key="test_model_key",
        internal_api_token="test_internal_token",
    )


@pytest.fixture
def make_message():
    def factory(message_id: int, message_type: Literal["user", "ai"] = "user") -> HistoryMessage:
        return HistoryMessage(
            id=message_id,
            app_id=123,
            user_id=456,
            message_type=message_type,
            message=f"消息 {message_id}",
            created_at=datetime(2026, 11, 25, 21, 32, 1),
            updated_at=datetime(2026, 11, 25, 21, 32, 1),
            is_deleted=False,
        )

    return factory
