import re
from pathlib import Path
from typing import Literal, cast, get_args

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

CodeGenType = Literal["html", "multi_file", "vue_project"]

PROMPT_PATH = Path(__file__).resolve().parents[1] / "prompts" / "codegen-routing-system-prompt.txt"
SYSTEM_PROMPT = PROMPT_PATH.read_text(encoding="utf-8") + (
    "\n只输出 html、multi_file 或 vue_project 三个值之一。不要添加解释。"
)
LEADING_REASONING = re.compile(r"\A<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


class InvalidRouteOutput(ValueError):
    pass


def parse_code_gen_type(text: str) -> CodeGenType:
    text = LEADING_REASONING.sub("", text.strip(), count=1)
    result = text.strip().lower()
    if result not in get_args(CodeGenType):
        raise InvalidRouteOutput("路由模型未返回有效的生成类型")
    return cast(CodeGenType, result)


class TypeRouter:
    def __init__(self, model: ChatOpenAI):
        self.model = model

    async def route(self, init_prompt: str) -> CodeGenType:
        response = await self.model.ainvoke(
            [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=init_prompt)],
            stream=True,
            store=False,
        )
        if response.response_metadata.get("finish_reason") != "completed":
            raise InvalidRouteOutput("路由模型未完整返回生成类型")
        return parse_code_gen_type(response.text)
