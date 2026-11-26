import json
from functools import partial
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_openai import ChatOpenAI

from app.api.dependencies import get_history
from app.db.history_repository import HistoryPage
from app.main import create_app
from app.routing.type_router import InvalidRouteOutput, parse_code_gen_type

HEADERS = {"X-Internal-Token": "test_internal_token"}
ROUTE = "/internal/v1/routing/code-gen-type"
MESSAGES = "/internal/v1/apps/123/messages"


@pytest.mark.parametrize(
    ("model_output", "expected"),
    [
        (" HTML\n", "html"),
        ("multi_file", "multi_file"),
        ("<think>比较 HTML 和多文件</think>\nVUE_PROJECT", "vue_project"),
    ],
)
def test_parse_route(model_output, expected):
    assert parse_code_gen_type(model_output) == expected


@pytest.mark.parametrize("model_output", ["", "html or multi_file", "html；这是解释", "<think>html"])
def test_reject_route_outside_allowlist(model_output):
    with pytest.raises(InvalidRouteOutput):
        parse_code_gen_type(model_output)


def test_admin_filter_preserves_java_paging_and_assistant_alias(settings, make_message):
    message = make_message(1900000000000000001, "ai")
    history = AsyncMock()
    history.repository.admin_page.return_value = HistoryPage([message], 11)
    app = create_app(settings)
    app.dependency_overrides[get_history] = lambda: history

    with TestClient(app) as client:
        response = client.post(
            "/internal/v1/admin/messages/page",
            json={"appId": "123", "userId": 456, "messageType": "assistant", "pageNum": 2},
            headers=HEADERS,
        )

    assert response.status_code == 200
    assert response.json() == {
        "records": [{
            "id": "1900000000000000001",
            "appId": "123",
            "userId": "456",
            "messageType": "ai",
            "message": message.message,
            "createTime": "2026-11-25T21:32:01",
            "updateTime": "2026-11-25T21:32:01",
            "isDelete": 0,
        }],
        "totalRow": 11,
    }
    history.repository.admin_page.assert_awaited_once_with(
        page=2, page_size=10, message_id=None, app_id=123, user_id=456, message_type="ai",
        message=None, before=None, sort_field="createTime", ascending=False,
    )


def test_health_token_and_cursor_validation(settings):
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get(MESSAGES).status_code == 401
        assert client.get(MESSAGES, headers={"X-Internal-Token": "other"}).status_code == 401
        for query in ("pageSize=51", "lastId=42", "lastCreateTime=2026-11-25T21:32:01.123"):
            assert client.get(f"{MESSAGES}?{query}", headers=HEADERS).status_code == 422


@pytest.mark.parametrize(
    ("output", "finish_status", "expected_status"),
    [("MULTI_FILE", "completed", 200), ("Use html.", "completed", 502), ("html", "incomplete", 502)],
)
def test_route_uses_responses_stream_and_checks_model_output(
    settings, monkeypatch, output, finish_status, expected_status
):
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append((request.url.path, json.loads(request.content)))
        events = [
            {
                "type": "response.output_text.delta",
                "sequence_number": 0,
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": output,
            },
            {
                "type": f"response.{finish_status}",
                "sequence_number": 1,
                "response": {
                    "id": "resp_1",
                    "object": "response",
                    "created_at": 0,
                    "model": "test-model",
                    "status": finish_status,
                    "output": [],
                },
            },
        ]
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            text="".join(f"data: {json.dumps(event)}\n\n" for event in events),
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    monkeypatch.setattr("app.model.ChatOpenAI", partial(ChatOpenAI, http_async_client=client))
    with TestClient(create_app(settings)) as api:
        response = api.post(ROUTE, json={"initPrompt": "创建两个简单静态页"}, headers=HEADERS)
        assert api.post(ROUTE, json={"initPrompt": "  "}, headers=HEADERS).status_code == 422

    assert response.status_code == expected_status, response.text
    if expected_status == 200:
        assert response.json() == {"codeGenType": "multi_file"}
    [(path, payload)] = requests
    assert path == "/v1/responses"
    assert payload["model"] == settings.model_name
    assert payload["stream"] is True
    assert payload["store"] is False
