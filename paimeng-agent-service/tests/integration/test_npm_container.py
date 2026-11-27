import json
import os
import subprocess
from uuid import uuid4

import pytest

from app.builder import npm_builder
from app.builder.npm_builder import NpmBuilder, _run_container

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("PAIMENG_TEST_DOCKER") != "1", reason="显式启用受控 Docker 构建测试"),
]

CHECK_SCRIPT = """
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
assert.notEqual(process.getuid(), 0)
for (const name of ['PYTHON_PG_PASSWORD', 'MODEL_API_KEY', 'INTERNAL_API_TOKEN', 'MEMORY_REDIS_URL']) {
  assert.equal(process.env[name], undefined, name)
}
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  assert.equal(process.env[name], '', name)
}
assert.equal(fs.readFileSync('/workspace/visible.txt', 'utf8'), 'current-task')
assert.equal(fs.existsSync('/workspace/../formal/host-only.txt'), false)
assert.equal(fs.existsSync('/var/run/docker.sock'), false)
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo'])
const status = fs.readFileSync('/proc/self/status', 'utf8')
assert.match(status, /^NoNewPrivs:\\s+1$/m)
assert.match(status, /^CapEff:\\s+0+$/m)
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n')
const root = mounts.find(line => line.split(' ')[4] === '/').split(' ')
assert.ok(root[5].split(',').includes('ro'))
const writableHostMounts = mounts.filter(line => line.split(' ').slice(4, 6).join(' ').startsWith('/workspace '))
assert.equal(writableHostMounts.length, 1)
fs.writeFileSync('/workspace/' + process.argv[2], 'isolated')
"""


async def test_npm_lifecycle_and_build_only_see_task_files_and_safe_env(tmp_path, monkeypatch):
    workspace = tmp_path / "current"
    workspace.mkdir()
    formal = tmp_path / "formal"
    formal.mkdir()
    (formal / "host-only.txt").write_text("outside", encoding="utf-8")
    (workspace / "visible.txt").write_text("current-task", encoding="utf-8")
    (workspace / "check.cjs").write_text(CHECK_SCRIPT, encoding="utf-8")
    (workspace / "build.cjs").write_text(
        "const fs = require('node:fs');\n"
        "if (!fs.existsSync('fixed.txt')) { console.error('error: fixture needs repair'); process.exit(1); }\n"
        "fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/index.html', '<html>passed</html>');",
        encoding="utf-8",
    )
    (workspace / "package.json").write_text(json.dumps({
        "name": "fixture",
        "version": "1.0.0",
        "scripts": {
            "postinstall": "node check.cjs lifecycle.txt",
            "build": "node check.cjs build.txt && node build.cjs",
        },
    }), encoding="utf-8")
    for key in ("PYTHON_PG_PASSWORD", "MODEL_API_KEY", "INTERNAL_API_TOKEN", "MEMORY_REDIS_URL"):
        monkeypatch.setenv(key, "host-fixture")

    execute_docker = npm_builder._docker
    networks = []

    async def inspect_then_run(args, log):
        if args[0] == "start":
            inspected = subprocess.run(
                ["docker", "inspect", args[-1]], capture_output=True, check=True,
            )
            [container] = json.loads(inspected.stdout)
            host = container["HostConfig"]
            [mount] = host["Mounts"]
            assert mount["Type"] == "bind" and mount["Target"] == "/workspace"
            assert os.path.normcase(mount["Source"]) == os.path.normcase(str(workspace))
            assert host["PidsLimit"] == 128 and host["Memory"] == 768 * 1024 * 1024
            networks.append(host["NetworkMode"])
        return await execute_docker(args, log)

    monkeypatch.setattr(npm_builder, "_docker", inspect_then_run)
    builder = NpmBuilder()
    first = await builder.build(workspace)
    assert not first.success and first.step == "build", first
    assert "fixture needs repair" in first.log
    assert (workspace / "lifecycle.txt").read_text(encoding="utf-8") == "isolated"
    assert (workspace / "build.txt").read_text(encoding="utf-8") == "isolated"
    assert not (workspace / "dist" / "index.html").exists()

    (workspace / "fixed.txt").touch()
    second = await builder.build(workspace)
    assert second.success, second
    assert (workspace / "dist" / "index.html").read_text(encoding="utf-8") == "<html>passed</html>"
    assert (formal / "host-only.txt").read_text(encoding="utf-8") == "outside"
    assert networks == ["bridge", "none", "none", "none"]


async def test_timeout_removes_container_and_its_child_processes(tmp_path, monkeypatch):
    container_id = uuid4()
    monkeypatch.setattr("app.builder.npm_builder.uuid4", lambda: container_id)
    result = await _run_container(
        tmp_path, "build", ["node", "-e", "require('node:child_process').spawn('sleep',['30']); setInterval(()=>{},50)"],
        3,
    )
    assert not result.success and "超过 3 秒" in result.log
    check = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"name=paimeng-npm-{container_id.hex}"],
        capture_output=True, check=True,
    )
    assert not check.stdout.strip()
