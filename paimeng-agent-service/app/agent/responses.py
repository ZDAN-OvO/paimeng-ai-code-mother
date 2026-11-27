from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from langchain_openai import ChatOpenAI
from openai import OpenAIError

from app.agent.reasoning import VisibleText

MAX_RESPONSE_CHARS = 512_000


class ResponsesError(RuntimeError):
    pass


@dataclass
class FunctionCall:
    call_id: str = ""
    name: str = ""
    arguments: str = ""

    def as_input(self) -> dict[str, str]:
        return {"type": "function_call", "call_id": self.call_id, "name": self.name, "arguments": self.arguments}


@dataclass
class ResponsesTurn:
    visible: VisibleText = field(default_factory=VisibleText)
    calls: dict[int, FunctionCall] = field(default_factory=dict)
    call_indexes: dict[str, int] = field(default_factory=dict)
    texts: dict[tuple[int, int], str] = field(default_factory=dict)
    complete: bool = False
    _received_chars: int = 0

    def _count(self, text: str) -> None:
        if "\x00" in text:
            raise ResponsesError("模型输出包含无效字符")
        try:
            text.encode("utf-8")
        except UnicodeError as exc:
            raise ResponsesError("模型输出包含无效字符") from exc
        self._received_chars += len(text)
        if self._received_chars > MAX_RESPONSE_CHARS:
            raise ResponsesError("单轮模型输出超过大小限制")

    def _text(self, key: tuple[int, int], text: str, *, full: bool = False) -> str:
        prefix = self.texts.get(key, "")
        if full:
            if not text and prefix:
                # 个别网关在终止快照中省略已发送的正文。
                return ""
            if not text.startswith(prefix):
                raise ResponsesError("模型正文与已发送的分片不一致")
            text = text[len(prefix):]
        self._count(text)
        self.texts[key] = prefix + text
        return self.visible.push(text)

    def _function_arguments(self, index: int, arguments: str, *, full: bool = False) -> None:
        call = self.calls.setdefault(index, FunctionCall())
        if full:
            if not arguments and call.arguments:
                return
            self._count(arguments[len(call.arguments):] if arguments.startswith(call.arguments) else arguments)
            call.arguments = arguments
        else:
            self._count(arguments)
            call.arguments += arguments

    def _function(self, index: int, item: Any) -> None:
        if item.id:
            index = self.call_indexes.setdefault(item.id, index)
        call = self.calls.setdefault(index, FunctionCall())
        if (call.call_id and call.call_id != item.call_id) or (call.name and call.name != item.name):
            raise ResponsesError("模型工具调用标识不一致")
        if getattr(item, "status", None) == "incomplete":
            raise ResponsesError("模型工具调用未完整返回")
        call.call_id, call.name = item.call_id, item.name
        self._function_arguments(index, item.arguments or "", full=True)

    def _item(self, index: int, item: Any) -> str:
        if item.type == "function_call":
            self._function(index, item)
        if item.type == "message":
            fragments = []
            for position, part in enumerate(item.content):
                if part.type == "refusal":
                    raise ResponsesError("模型拒绝了本次生成")
                if part.type == "output_text":
                    fragments.append(self._text((index, position), part.text, full=True))
            return "".join(fragments)
        return ""

    def accept(self, event: Any) -> str:
        kind = event.type
        if kind == "response.output_text.delta":
            return self._text((event.output_index, event.content_index), event.delta)
        if kind == "response.output_text.done":
            return self._text((event.output_index, event.content_index), event.text, full=True)
        if kind == "response.function_call_arguments.delta":
            index = self.call_indexes.setdefault(event.item_id, event.output_index)
            self._function_arguments(index, event.delta)
        elif kind == "response.function_call_arguments.done":
            index = self.call_indexes.setdefault(event.item_id, event.output_index)
            self._function_arguments(index, event.arguments, full=True)
        elif kind == "response.output_item.added" and event.item.type == "function_call":
            self._function(event.output_index, event.item)
        elif kind == "response.output_item.done":
            return self._item(event.output_index, event.item)
        elif kind == "response.completed":
            if event.response.status not in (None, "completed"):
                raise ResponsesError("模型未完成本轮输出")
            extra = [self._item(index, item) for index, item in enumerate(event.response.output)]
            call_ids = [call.call_id for call in self.calls.values()]
            if any(not call.call_id or not call.name for call in self.calls.values()) or (
                len(call_ids) != len(set(call_ids))
            ):
                raise ResponsesError("模型未返回有效的工具调用标识")
            self.complete = True
            return "".join(extra) + self.visible.push("", final=True)
        elif kind in {"response.incomplete", "response.failed", "error"}:
            raise ResponsesError("模型未完成本轮输出")
        elif kind in {"response.refusal.delta", "response.refusal.done"}:
            raise ResponsesError("模型拒绝了本次生成")
        return ""


class ResponsesModel:
    def __init__(self, model: ChatOpenAI):
        self.model = model

    def token_count(self, text: str) -> int:
        try:
            return self.model.get_num_tokens(text)
        except (OSError, ValueError):
            # 编码表不可用或正文包含保留标记时，使用更保守的 UTF-8 字节数。
            return len(text.encode("utf-8"))

    async def stream(
        self, turn: ResponsesTurn, items: list[dict], tools: list[dict] | None
    ) -> AsyncIterator[str]:
        # 使用同一 LangChain 实例的已配置客户端，以读取原始终止事件和完整函数参数。
        options = {"tools": tools, "parallel_tool_calls": True} if tools else {}
        try:
            response = await self.model.root_async_client.responses.create(
                model=self.model.model_name, input=items, stream=True, store=False, **options,
            )
            async with response:
                async for event in response:
                    text = turn.accept(event)
                    if text:
                        yield text
                    if turn.complete:
                        break
        except OpenAIError as exc:
            raise ResponsesError("模型网关请求失败") from exc
        if not turn.complete:
            raise ResponsesError("模型流断开，未收到完成事件")
