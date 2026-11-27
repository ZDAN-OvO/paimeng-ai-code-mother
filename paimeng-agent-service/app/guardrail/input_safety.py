import re

SENSITIVE_WORDS = (
    "忽略之前的指令", "ignore previous instructions", "ignore above",
    "破解", "hack", "绕过", "bypass", "越狱", "jailbreak",
)
INJECTION_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"ignore\s+(?:previous|above|all)\s+(?:instructions?|commands?|prompts?)",
    r"(?:forget|disregard)\s+(?:everything|all)\s+(?:above|before)",
    r"(?:pretend|act|behave)\s+(?:as|like)\s+(?:if|you\s+are)",
    r"system\s*:\s*you\s+are",
    r"new\s+(?:instructions?|commands?|prompts?)\s*:",
))


def validate_input(message: str) -> None:
    if len(message.encode("utf-16-le")) // 2 > 1000:
        raise ValueError("输入内容过长，不要超过 1000 字")
    if not message.strip():
        raise ValueError("输入内容不能为空")
    if any(word in message.lower() for word in SENSITIVE_WORDS):
        raise ValueError("输入包含不当内容，请修改后重试")
    if any(pattern.search(message) for pattern in INJECTION_PATTERNS):
        raise ValueError("检测到恶意输入，请求被拒绝")
