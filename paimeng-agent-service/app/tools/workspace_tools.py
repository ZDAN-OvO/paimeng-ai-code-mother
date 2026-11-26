import json
import ntpath
import os
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.agent.reasoning import THINK_TAG
from app.routing.type_router import CodeGenType

PROTECTED_NAMES = frozenset({
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "vite.config.js", "vite.config.ts", "vue.config.js", "tsconfig.json",
    "tsconfig.app.json", "tsconfig.node.json", "index.html", "main.js", "main.ts",
    "app.vue", ".gitignore", "readme.md",
})
IGNORED_NAMES = frozenset({
    "node_modules", ".git", "dist", "build", ".ds_store", ".env", "target",
    ".mvn", ".idea", ".vscode", "coverage",
})
IGNORED_EXTENSIONS = frozenset({".log", ".tmp", ".cache", ".lock"})
MAX_TOOL_OUTPUT = 24_000


class WorkspaceError(ValueError):
    pass


def generation_workspace(root: Path | None, mode: CodeGenType, app_id: int, task_id: UUID) -> Path:
    if root is None or not root.is_absolute():
        raise WorkspaceError("PAIMENG_WORKSPACE_ROOT 必须配置为绝对路径")
    directory = root.resolve()
    for name in ("code_staging", f"{mode}_{app_id}", str(task_id)):
        directory /= name
        if directory.is_symlink() or directory.is_junction() or not directory.is_dir():
            raise WorkspaceError("本轮临时目录不存在或经过链接")
    return directory


def _check_entry(info: os.stat_result, *, allow_hardlinks: bool = False) -> None:
    if stat.S_ISREG(info.st_mode):
        if info.st_nlink > 1 and not allow_hardlinks:
            raise WorkspaceError("工作区包含硬链接")
    elif not stat.S_ISDIR(info.st_mode):
        raise WorkspaceError("工作区包含不支持的文件类型")


def resolve_safe_path(workspace: Path, relative_path: str, *, allow_hardlinks: bool = False) -> Path:
    windows = PureWindowsPath(relative_path)
    posix = PurePosixPath(relative_path.replace("\\", "/"))
    if windows.anchor or posix.is_absolute() or ".." in posix.parts:
        raise WorkspaceError("只允许使用本轮临时目录内的相对路径")
    if any(ntpath.isreserved(part) for part in posix.parts):
        raise WorkspaceError("路径包含保留名称或字符")

    root = workspace.resolve(strict=True)
    candidate = root.joinpath(*posix.parts)
    target = candidate.resolve()
    if not target.is_relative_to(root):
        raise WorkspaceError("路径指向本轮临时目录外")
    try:
        _check_entry(target.stat(), allow_hardlinks=allow_hardlinks)
    except FileNotFoundError:
        if candidate.is_symlink() or candidate.is_junction():
            raise WorkspaceError("路径指向不存在的链接目标") from None
    return target


def scan_workspace(workspace: Path) -> None:
    """逐项检查文件类型与链接目标，不递归进入链接目录。"""
    pending = [workspace]
    hardlinks: dict[tuple[int, int], tuple[int, int]] = {}
    while pending:
        for entry in pending.pop().iterdir():
            if entry.is_symlink() or entry.is_junction():
                resolve_safe_path(workspace, entry.relative_to(workspace).as_posix(), allow_hardlinks=True).stat()
                continue
            info = entry.lstat()
            _check_entry(info, allow_hardlinks=True)
            if stat.S_ISDIR(info.st_mode):
                pending.append(entry)
            elif info.st_nlink > 1:
                # esbuild 等依赖会在工作区内创建硬链接。所有链接都在本轮目录中才允许交付。
                if not info.st_ino:
                    raise WorkspaceError("无法核验工作区硬链接")
                key = (info.st_dev, info.st_ino)
                count, expected = hardlinks.get(key, (0, info.st_nlink))
                if info.st_nlink != expected:
                    raise WorkspaceError("工作区硬链接在核验期间发生变化")
                hardlinks[key] = count + 1, expected
    if any(count != expected for count, expected in hardlinks.values()):
        raise WorkspaceError("工作区包含链接到本轮临时目录外的硬链接")


class _Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _FileArguments(_Arguments):
    relativeFilePath: str = Field(min_length=1, description="文件的相对路径")


class _WriteArguments(_FileArguments):
    content: str = Field(description="完整文件内容")


class _ModifyArguments(_FileArguments):
    oldContent: str = Field(min_length=1, description="要替换的原文，必须与文件内内容一致")
    newContent: str = Field(description="替换后的内容")


class _DirectoryArguments(_Arguments):
    relativeDirPath: str | None = Field(default=None, description="目录相对路径，为空时读取项目根目录")


TOOL_ARGUMENTS = {
    "writeFile": (_WriteArguments, "写入或完整覆盖指定文件"),
    "readFile": (_FileArguments, "读取指定文件"),
    "modifyFile": (_ModifyArguments, "用新内容替换文件中的指定原文"),
    "deleteFile": (_FileArguments, "删除指定文件，核心文件受保护"),
    "readDir": (_DirectoryArguments, "读取指定目录的项目结构"),
    "exit": (_Arguments, "文件变更已完成，请求结束工具调用"),
}

TOOL_SCHEMAS = [
    {"type": "function", "name": name, "description": description, "parameters": arguments.model_json_schema()}
    for name, (arguments, description) in TOOL_ARGUMENTS.items()
]


@dataclass(frozen=True)
class ToolResult:
    output: str
    message: str
    is_error: bool = False


def _bounded(text: str) -> str:
    if len(text) <= MAX_TOOL_OUTPUT:
        return text
    return text[:MAX_TOOL_OUTPUT] + "\n…（输出已截断）"


def _check_file_text(text: str) -> None:
    if THINK_TAG.search(text):
        raise WorkspaceError("文件内容包含推理标记，请仅提交文件源码")


class WorkspaceTools:
    def __init__(self, workspace: Path):
        self.workspace = workspace

    def call(self, name: str, raw_arguments: str) -> ToolResult:
        try:
            if name not in TOOL_ARGUMENTS:
                raise WorkspaceError("未知工具")
            schema, _ = TOOL_ARGUMENTS[name]
            arguments = schema.model_validate(json.loads(raw_arguments))
            return self._execute(name, arguments)
        except (ValidationError, json.JSONDecodeError):
            message = "工具参数格式错误，请按工具定义重试"
        except WorkspaceError as exc:
            message = str(exc)
        except FileNotFoundError:
            message = "指定文件或目录不存在"
        except (OSError, RuntimeError, ValueError) as exc:
            message = f"文件操作失败（{type(exc).__name__}）"
        return ToolResult(f"错误：{message}", message, is_error=True)

    def _execute(self, name: str, arguments: _Arguments) -> ToolResult:
        if name == "exit":
            return ToolResult("不要继续调用工具，可以输出最终结果了", "已结束文件操作")
        if isinstance(arguments, _DirectoryArguments):
            target = resolve_safe_path(self.workspace, arguments.relativeDirPath or "")
            return ToolResult(self._directory(target), f"已读取目录 {arguments.relativeDirPath or '.'}")
        assert isinstance(arguments, _FileArguments)
        relative = arguments.relativeFilePath
        target = resolve_safe_path(self.workspace, relative)
        if isinstance(arguments, _WriteArguments):
            _check_file_text(arguments.content)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(arguments.content, encoding="utf-8", newline="")
            message = f"文件写入成功：{relative}"
            return ToolResult(message, message)
        if not target.is_file():
            raise WorkspaceError("指定路径不存在或不是文件")
        if name == "readFile":
            with target.open(encoding="utf-8", newline="") as file:
                return ToolResult(_bounded(file.read(MAX_TOOL_OUTPUT + 1)), f"已读取文件 {relative}")
        if name == "deleteFile":
            source_name = PureWindowsPath(relative).name.lower()
            if source_name in PROTECTED_NAMES or target.name.lower() in PROTECTED_NAMES:
                raise WorkspaceError("不允许删除核心文件")
            target.unlink()
            message = f"文件删除成功：{relative}"
            return ToolResult(message, message)
        assert isinstance(arguments, _ModifyArguments)
        with target.open(encoding="utf-8", newline="") as file:
            original = file.read()
        if arguments.oldContent not in original:
            raise WorkspaceError("文件中未找到要替换的内容")
        updated = original.replace(arguments.oldContent, arguments.newContent)
        _check_file_text(updated)
        target.write_text(updated, encoding="utf-8", newline="")
        message = f"文件修改成功：{relative}"
        return ToolResult(message, message)

    def _directory(self, target: Path) -> str:
        if not target.is_dir():
            raise WorkspaceError("指定路径不存在或不是目录")
        paths = ["项目目录结构："]
        size = len(paths[0])
        for directory, folders, filenames in target.walk(follow_symlinks=False):
            folders[:] = sorted(
                name for name in folders
                if name.lower() not in IGNORED_NAMES and not (directory / name).is_junction()
            )
            for name in sorted(folders + filenames):
                if name.lower() in IGNORED_NAMES or Path(name).suffix.lower() in IGNORED_EXTENSIONS:
                    continue
                path = (directory / name).relative_to(target).as_posix()
                paths.append(path)
                size += len(path) + 1
                if size > MAX_TOOL_OUTPUT:
                    return _bounded("\n".join(paths))
        return "\n".join(paths)
