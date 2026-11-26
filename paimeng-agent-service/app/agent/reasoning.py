import re

THINK_TAG = re.compile(r"</?think>", re.IGNORECASE)
_TAGS = ("<think>", "</think>")


class VisibleText:
    """过滤流式正文中夹带的推理标记，保留分片跨越标记边界时的状态。"""

    def __init__(self):
        self.pending = ""
        self.in_think = False
        self.confirmed = False
        self.prefix: list[str] = []
        self.parts: list[str] = []

    def push(self, text: str, *, final: bool = False) -> str:
        text = self.pending + text
        self.pending = ""
        if not final:
            for length in range(min(len(text), len(_TAGS[1]) - 1), 0, -1):
                if any(tag.startswith(text[-length:].lower()) for tag in _TAGS):
                    text, self.pending = text[:-length], text[-length:]
                    break

        visible: list[str] = []
        position = 0
        for marker in THINK_TAG.finditer(text):
            if not self.in_think:
                (visible if self.confirmed else self.prefix).append(text[position:marker.start()])
            if marker.group().startswith("</"):
                if not self.confirmed:
                    # 网关有时省略起始标记。闭标签前的文本尚不能确认为正文。
                    self.prefix.clear()
                    self.confirmed = True
                self.in_think = False
            else:
                self.in_think = True
            position = marker.end()
        if not self.in_think:
            (visible if self.confirmed else self.prefix).append(text[position:])
            if final and not self.confirmed:
                # 没有推理标记时，收到完整响应才能确认此前的文本。
                visible.extend(self.prefix)
                self.prefix.clear()
                self.confirmed = True
        result = "".join(visible)
        if result:
            self.parts.append(result)
        return result

    @property
    def content(self) -> str:
        return "".join(self.parts)
