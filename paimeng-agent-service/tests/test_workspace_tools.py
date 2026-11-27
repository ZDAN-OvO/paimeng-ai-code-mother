import json
import os
import subprocess
from uuid import uuid4

import pytest

from app.tools.workspace_tools import WorkspaceError, WorkspaceTools, generation_workspace, resolve_safe_path, scan_workspace


@pytest.mark.parametrize("name", [
    "../outside.txt", r"folder\..\file.txt", "/etc/passwd", r"C:\data\file.txt",
    "C:file.txt", r"\\example\share", r"\absolute", "file.txt:stream", "NUL.txt", "file.txt.",
])
def test_workspace_rejects_paths_outside_or_aliased_by_windows(tmp_path, name):
    with pytest.raises(WorkspaceError):
        resolve_safe_path(tmp_path, name)


def _directory_link(link, target):
    if os.name == "nt":
        command = ["cmd.exe", "/c", "mklink", "/J", str(link), str(target)]
        subprocess.run(command, check=True, capture_output=True)
        assert link.is_junction()
    else:
        link.symlink_to(target, target_is_directory=True)
        assert link.is_symlink()


def test_outside_link_is_rejected_by_tools_and_artifact_scan(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "hidden.txt").write_text("fixture", encoding="utf-8")
    _directory_link(workspace / "escape", outside)

    with pytest.raises(WorkspaceError, match="指向本轮临时目录外"):
        resolve_safe_path(workspace, "escape/hidden.txt")
    with pytest.raises(WorkspaceError, match="指向本轮临时目录外"):
        scan_workspace(workspace)


def test_windows_junction_or_symlink_cannot_replace_staging_root(tmp_path):
    external = tmp_path / "external"
    external.mkdir()
    _directory_link(tmp_path / "code_staging", external)
    task = uuid4()
    (external / "html_123" / str(task)).mkdir(parents=True)
    with pytest.raises(WorkspaceError):
        generation_workspace(tmp_path, "html", 123, task)


def test_file_symlink_does_not_expose_its_external_target(tmp_path):
    external = tmp_path / "outside.txt"
    external.write_text("host file", encoding="utf-8")
    workspace = tmp_path / "staging"
    workspace.mkdir()
    try:
        (workspace / "link.txt").symlink_to(external)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("Windows 当前用户无符号链接创建权限")
        raise

    with pytest.raises(WorkspaceError, match="指向本轮临时目录外"):
        scan_workspace(workspace)
    tools = WorkspaceTools(workspace)
    assert tools.call("writeFile", '{"relativeFilePath":"link.txt","content":"changed"}').is_error
    assert external.read_text(encoding="utf-8") == "host file"


def test_tools_validate_args_protect_core_and_filter_read_dir(tmp_path):
    tools = WorkspaceTools(tmp_path)
    core = tmp_path / "src" / "App.vue"
    core.parent.mkdir()
    core.write_text("原始内容", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.js").touch()
    assert tools.call("deleteFile", json.dumps({"relativeFilePath": "src/App.vue"})).is_error
    assert tools.call("readFile", '{"relativeFilePath":false}').is_error
    assert tools.call("writeFile", '{"relativeFilePath":"new.html","content":"</think>foo"}').is_error
    assert tools.call("readFile", '{"relativeFilePath":"src/App.vue"}').output == "原始内容"
    listing = tools.call("readDir", "{}").output
    assert "src/App.vue" in listing and "ignored.js" not in listing
    assert not (tmp_path / "new.html").exists()


def test_workspace_refuses_hardlink_to_host_file(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    workspace = tmp_path / "staging"
    workspace.mkdir()
    (workspace / "alias.txt").hardlink_to(outside)
    with pytest.raises(WorkspaceError, match="硬链接"):
        scan_workspace(workspace)
    with pytest.raises(WorkspaceError, match="硬链接"):
        resolve_safe_path(workspace, "alias.txt")


def test_scan_accepts_hardlinks_only_when_all_names_are_in_the_workspace(tmp_path):
    workspace = tmp_path / "staging"
    workspace.mkdir()
    original = workspace / "project.bin"
    original.touch()
    (workspace / "dependency.bin").hardlink_to(original)
    scan_workspace(workspace)

    (tmp_path / "outside.bin").hardlink_to(original)
    with pytest.raises(WorkspaceError, match="目录外的硬链接"):
        scan_workspace(workspace)
