import re
from html.parser import HTMLParser
from pathlib import Path

from app.routing.type_router import CodeGenType
from app.tools.workspace_tools import WorkspaceError, resolve_safe_path

FENCED_BLOCK = re.compile(
    r"^[ \t]*`{3,}([A-Za-z]+)[ \t]*\r?\n(.*?)^[ \t]*`{3,}[ \t]*(?=\r?$)",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)
HTML_START = re.compile(r"\A(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))", re.IGNORECASE)

STATIC_ASSETS = (("css", "style.css"), ("javascript", "script.js"))


class MissingStaticAssets(WorkspaceError):
    def __init__(self, filenames: list[str]):
        self.filenames = filenames
        super().__init__("页面引用的文件缺失：" + "、".join(filenames))


class _AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.files: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attribute = {"link": "href", "script": "src"}.get(tag)
        if not attribute:
            return
        path = (dict(attrs).get(attribute) or "").split("?", 1)[0].split("#", 1)[0]
        self.files.add(path.removeprefix("./"))


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
        references = _AssetReferences()
        references.feed(html)
        references.close()
        missing = []
        for language, filename in STATIC_ASSETS:
            source = blocks.get(language, "")
            if source:
                files[filename] = source
                continue
            if filename not in references.files:
                continue
            if not resolve_safe_path(workspace, filename).is_file():
                missing.append(filename)
        if missing:
            raise MissingStaticAssets(missing)
    for filename, source in files.items():
        resolve_safe_path(workspace, filename).write_text(source, encoding="utf-8", newline="")
