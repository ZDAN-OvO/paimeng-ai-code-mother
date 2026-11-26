import re
from pathlib import Path

from app.routing.type_router import CodeGenType
from app.tools.workspace_tools import WorkspaceError, resolve_safe_path

FENCED_BLOCK = re.compile(
    r"^[ \t]*`{3,}([A-Za-z]+)[ \t]*\r?\n(.*?)^[ \t]*`{3,}[ \t]*(?=\r?$)",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)
HTML_START = re.compile(r"\A(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))", re.IGNORECASE)


def save_static_files(workspace: Path, mode: CodeGenType, content: str) -> None:
    blocks: dict[str, str] = {}
    for match in FENCED_BLOCK.finditer(content):
        language = match[1].lower()
        blocks.setdefault("javascript" if language == "js" else language, match[2].strip())

    html = blocks.get("html", "")
    if not html and mode == "html" and HTML_START.match(content.strip()):
        html = content.strip()
    if not html:
        raise WorkspaceError("模型未生成非空的 HTML 页面")

    files = {"index.html": html}
    if mode == "multi_file":
        for language, filename in (("css", "style.css"), ("javascript", "script.js")):
            if blocks.get(language):
                files[filename] = blocks[language]
    for filename, source in files.items():
        resolve_safe_path(workspace, filename).write_text(source, encoding="utf-8", newline="")
