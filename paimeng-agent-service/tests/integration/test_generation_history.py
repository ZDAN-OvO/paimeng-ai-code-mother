import asyncio
from unittest.mock import Mock
from uuid import uuid4

import httpx
import pytest

from app.api.dependencies import get_history
from app.db.history_repository import GenerationTaskNotFound, MessageConflict
from app.history import HistoryService
from app.main import create_app

pytestmark = pytest.mark.integration


async def test_result_is_durable_and_concurrent_retry_increments_version_once(service, repository):
    task = uuid4()
    user = await service.start_generation(123, 456, task, "生成一个项目")
    snapshot = await service.load_context(123)
    assert snapshot.version == 1 and snapshot.messages == [user]

    with pytest.raises(MessageConflict):
        await service.start_generation(123, 456, task, "生成一个项目")
    with pytest.raises(GenerationTaskNotFound):
        await service.commit_generation_result(124, task, "failed", "断流", None)

    # 新的服务实例模拟重连，结果以 PG 为准。
    retry = HistoryService(repository, service.memory)
    result = {"attempt": 1, "success": True, "detail": [None, {"count": 1}]}
    first, duplicate = await asyncio.gather(
        service.commit_generation_result(123, task, "success", "生成成功", result),
        retry.commit_generation_result(123, task, "success", "生成成功", result),
    )
    assert first == duplicate and first.user_id == 456 and first.message_type == "ai"
    with pytest.raises(MessageConflict):
        await retry.commit_generation_result(123, task, "failed", "生成成功", result)
    with pytest.raises(MessageConflict):
        await retry.commit_generation_result(123, task, "success", "生成成功", {
            **result, "detail": [None, {"count": True}],
        })
    assert (await retry.load_context(123)).messages == [user, first]
    assert await repository.version(123) == 2
    assert (await service.memory.observe(123)).version == "2"


async def test_disconnected_generation_can_commit_failure_without_candidate(service, repository):
    task = uuid4()
    user = await service.start_generation(123, 456, task, "请求生成")
    page = await repository.app_page(123, 10, None, None)
    assert page.records == [user]
    result = await service.commit_generation_result(123, task, "failed", "生成流已断开", None)
    assert result.message == "生成流已断开"
    assert await service.commit_generation_result(123, task, "failed", "生成流已断开", None) == result
    assert (await repository.app_page(123, 10, None, None)).records == [result, user]


async def test_registration_commit_and_delayed_run_share_the_same_task(service, repository, settings):
    app = create_app(settings)
    app.state.settings = settings
    app.state.generation = Mock()
    app.dependency_overrides[get_history] = lambda: service
    task_id = str(uuid4())
    registration = {"taskId": task_id, "userId": "456", "messageType": "user", "message": "请求生成"}
    terminal = {"taskId": task_id, "status": "failed", "content": "连接提前中断", "buildResult": None}
    history_url = "/internal/v1/apps/123/messages"
    commit_url = history_url + "/commit-result"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"X-Internal-Token": settings.internal_api_token.get_secret_value()},
    ) as client:
        assert (await client.post(commit_url, json=terminal)).status_code == 404
        first = await client.post(history_url, json=registration)
        second = await client.post(history_url, json=registration)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()
        assert (await client.post(history_url, json={**registration, "message": "不同内容"})).status_code == 409
        assert (await client.post(history_url, json={**registration, "messageType": "ai"})).status_code == 422

        committed = await client.post(commit_url, json=terminal)
        assert committed.status_code == 200 and committed.json()["userId"] == "456"
        assert (await client.post(commit_url, json=terminal)).json() == committed.json()
        late_run = await client.post("/internal/v1/generation/runs", json={
            "appId": "123", "userId": "456", "taskId": task_id, "codeGenType": "html", "message": "请求生成",
        })
        assert late_run.status_code == 409
        app.state.generation.events.assert_not_called()
        assert (await client.get(history_url)).json()["totalRow"] == 2
    assert await repository.version(123) == 2


async def test_old_messages_stay_in_history_after_the_context_window_is_full(service, repository):
    for index in range(23):
        await service.append(123, 456, "user", f"旧历史 {index}")
    current = await service.start_generation(123, 456, uuid4(), "续改")
    visible = await service.load_context(123)
    assert len(visible.messages) == 20 and visible.messages[-1] == current
    assert visible.messages[0].message == "旧历史 4"
    full = await repository.app_page(123, 30, None, None)
    assert full.total == 24 and full.records[-1].message == "旧历史 0"
