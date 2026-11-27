import asyncio
import csv
import hashlib
import io
import logging
import os
import re
import shutil
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from uuid import uuid4

from anyio import CancelScope

from app.tools.workspace_tools import WorkspaceError, resolve_safe_path, scan_workspace

logger = logging.getLogger(__name__)
NODE_IMAGE = "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"
INSTALL_TIMEOUT = 300
BUILD_TIMEOUT = 180
MAX_BUILD_LOG = 4000
ERROR_LINE = re.compile(r"\b(error|failed|cannot|exception|enoent|npm err)\b", re.IGNORECASE)
PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY")


@dataclass(frozen=True)
class BuildResult:
    success: bool
    step: str
    log: str = ""


class _CommandLog:
    def __init__(self):
        self.partial = b""
        self.tail: deque[str] = deque(maxlen=36)
        self.errors: deque[str] = deque(maxlen=20)

    def _line(self, encoded: bytes) -> None:
        line = encoded.decode("utf-8", errors="replace").replace("\x00", "").strip()[:1000]
        if not line:
            return
        if ERROR_LINE.search(line):
            self.errors.extend([*list(self.tail)[-2:], line])
        self.tail.append(line)

    def push(self, chunk: bytes) -> None:
        *lines, self.partial = (self.partial + chunk).split(b"\n")
        for line in lines:
            self._line(line)
        self.partial = self.partial[-8192:]

    def excerpt(self) -> str:
        self._line(self.partial)
        tail = "\n".join(self.tail)
        if not self.errors:
            return tail[-MAX_BUILD_LOG:]
        errors = "\n".join(dict.fromkeys(self.errors))
        return (errors[-3000:] + "\n…\n" + tail[-990:]).strip()


async def _docker(arguments: list[str], log: _CommandLog) -> int:
    process = await asyncio.create_subprocess_exec(
        "docker", *arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
    )
    assert process.stdout is not None
    try:
        while chunk := await process.stdout.read(8192):
            log.push(chunk)
        return await process.wait()
    finally:
        if process.returncode is None:
            with CancelScope(shield=True):
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()


def _mount(workspace: Path) -> str:
    result = io.StringIO()
    csv.writer(result, lineterminator="").writerow(
        ["type=bind", f"source={workspace}", "target=/workspace"]
    )
    return result.getvalue()


async def _run_container(
    workspace: Path, step: str, command: list[str], timeout: int, *, network: bool = False
) -> BuildResult:
    name = f"paimeng-npm-{uuid4().hex}"
    user = "1000:1000"
    if os.name == "posix" and os.geteuid() != 0:
        user = f"{os.geteuid()}:{os.getegid()}"
    # Docker CLI 可以把本机配置的代理 URL 自动注入容器，其中可能带认证信息。
    empty_proxies = [f"--env={name}=" for key in PROXY_VARIABLES for name in (key, key.lower())]
    create = [
        "create", "--name", name, "--pull", "missing", "--init", "--entrypoint", command[0],
        "--user", user, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
        "--pids-limit", "128", "--memory", "768m", "--memory-swap", "768m", "--cpus", "2",
        "--network", "bridge" if network else "none",
        "--mount", _mount(workspace), "--workdir", "/workspace",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--env", "HOME=/tmp", "--env", "NPM_CONFIG_CACHE=/tmp/npm-cache", "--env", "CI=true",
        *empty_proxies,
        NODE_IMAGE, *command[1:],
    ]
    log = _CommandLog()
    try:
        async with asyncio.timeout(timeout):
            if await _docker(create, log) != 0:
                return BuildResult(False, "container", log.excerpt() or "无法创建构建容器")
            log = _CommandLog()
            code = await _docker(["start", "--attach", name], log)
            return BuildResult(code == 0, step, "" if code == 0 else log.excerpt() or f"退出码 {code}")
    except TimeoutError:
        detail = log.excerpt()
        timing = f"{step} 超过 {timeout} 秒，已停止本次构建"
        return BuildResult(False, step, (timing + "\n" + detail)[:MAX_BUILD_LOG].rstrip())
    except OSError:
        return BuildResult(False, "container", "无法启动 Docker CLI")
    finally:
        with CancelScope(shield=True):
            try:
                async with asyncio.timeout(20):
                    cleanup_log = _CommandLog()
                    removed = await _docker(["rm", "--force", name], cleanup_log)
                    if removed and "No such container" not in cleanup_log.excerpt():
                        logger.error("清理构建容器失败，name=%s", name)
            except (OSError, TimeoutError):
                logger.error("无法清理构建容器，name=%s", name)


class NpmBuilder:
    def __init__(self):
        self._installed_signature: tuple[bytes, bytes | None] | None = None

    async def build(self, workspace: Path) -> BuildResult:
        package = resolve_safe_path(workspace, "package.json")
        if not package.is_file():
            return BuildResult(False, "install", "缺少 package.json，请补齐项目依赖和 build 脚本")

        scan_workspace(workspace)
        signature = self._dependency_signature(workspace, package)
        if signature != self._installed_signature:
            # 仅依赖下载使用网络，项目生命周期和构建脚本都在断网容器内运行。
            deadline = monotonic() + INSTALL_TIMEOUT
            install = await _run_container(
                workspace, "install",
                ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
                INSTALL_TIMEOUT, network=True,
            )
            if not install.success:
                return install
            scan_workspace(workspace)
            remaining = int(deadline - monotonic())
            if remaining <= 0:
                return BuildResult(False, "install", f"安装依赖超过 {INSTALL_TIMEOUT} 秒")
            rebuild = await _run_container(workspace, "install", ["npm", "rebuild", "--offline"], remaining)
            if not rebuild.success:
                return rebuild
            scan_workspace(workspace)
            self._installed_signature = self._dependency_signature(workspace, package)

        # 续改复制过来的 dist 不能被当成本次构建产物。
        dist = workspace / "dist"
        if dist.is_symlink() or dist.is_junction():
            raise WorkspaceError("构建产物目录不能是链接")
        if dist.is_dir():
            shutil.rmtree(dist)
        elif dist.exists():
            dist.unlink()
        result = await _run_container(workspace, "build", ["npm", "run", "build"], BUILD_TIMEOUT)
        scan_workspace(workspace)
        if not result.success:
            return result
        index = resolve_safe_path(workspace, "dist/index.html")
        if not index.is_file() or index.stat().st_size == 0:
            return BuildResult(False, "build", "构建没有生成非空的 dist/index.html")
        return result

    @staticmethod
    def _dependency_signature(workspace: Path, package: Path) -> tuple[bytes, bytes | None]:
        lockfile = resolve_safe_path(workspace, "package-lock.json")
        return (
            hashlib.sha256(package.read_bytes()).digest(),
            hashlib.sha256(lockfile.read_bytes()).digest() if lockfile.is_file() else None,
        )
