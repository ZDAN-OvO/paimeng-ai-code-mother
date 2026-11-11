/**
 * pr-gate 入口的行为测试：在临时 Git 仓库里用真实参数跑 CLI，验证退出码与提示。
 * 判定细节在 `gate.test.ts`。
 *
 * 远端头来自 GitHub API，测试用 `PR_GATE_GH` 指向的替身脚本提供返回值，
 * 这样既能验证 CLI 的参数与拒绝路径，也不需要网络和登录态。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const gateEntry = path.join(repoRoot, 'scripts', 'pr-gate.ts');

const root = mkdtempSync(path.join(os.tmpdir(), 'pr-gate-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 替身 gh：成功时输出 $FAKE_GH_SHA 的内容，$FAKE_GH_FAIL 非空时模拟查询失败。 */
const fakeGh = path.join(root, 'fake-gh');
writeFileSync(
  fakeGh,
  `#!/bin/sh
if [ -n "$FAKE_GH_FAIL" ]; then
  echo "HTTP 404: Not Found (branch or repo)" >&2
  exit 1
fi
if [ -n "$FAKE_GH_LOG" ]; then
  printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
fi
cat "$FAKE_GH_SHA"
`,
);
chmodSync(fakeGh, 0o755);

let seq = 0;
const uniqueName = (prefix: string) => `${prefix}-${++seq}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=gate-test', '-c', 'user.email=gate@test', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** 一个普通仓库；origin 指向 GitHub，但测试不会真的联网。 */
function sandbox(
  name: string,
  { originUrl = 'https://github.com/example/repo.git' as string | null } = {},
) {
  const dir = path.join(root, name);
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  if (originUrl) git(work, 'remote', 'add', 'origin', originUrl);
  writeFileSync(path.join(work, 'file.txt'), 'base\n');
  git(work, 'add', 'file.txt');
  git(work, 'commit', '-q', '-m', 'base');

  return {
    dir,
    work,
    sha: () => git(work, 'rev-parse', 'HEAD'),
    report(name: string, value: unknown) {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    },
    run(args: string[], env: Record<string, string> = {}) {
      try {
        const output = execFileSync(tsx, [gateEntry, ...args], {
          cwd: work,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PR_GATE_GH: fakeGh,
            FAKE_GH_SHA: path.join(dir, 'sha.txt'),
            ...env,
          },
        });
        return { code: 0, output };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      }
    },
    /** 让替身 gh 认为远端分支指向某个提交。 */
    remoteAt(sha: string) {
      writeFileSync(path.join(dir, 'sha.txt'), `${sha}\n`);
    },
  };
}

const reports = (box: ReturnType<typeof sandbox>, sha: string) => {
  const ci = box.report('ci.json', { headSha: sha, conclusion: 'success' });
  const code = box.report('code.json', {
    sha,
    reviewer: 'code',
    model: 'xhy-api/gpt-6.1-sol',
    verdict: 'passed',
  });
  const completion = box.report('completion.json', {
    sha,
    reviewer: 'completion',
    model: 'auto/glm-5.3-flash',
    verdict: 'passed',
  });
  return { ci, code, completion };
};

const args = (
  sha: string,
  r: { ci: string; code: string; completion: string },
  extra: string[] = [],
) => [
  '--sha',
  sha,
  '--ci',
  r.ci,
  '--code-review',
  r.code,
  '--completion-review',
  r.completion,
  ...extra,
];

describe('pr-gate 入口', () => {
  it('CI、两份审查与 GitHub 上的分支头都指向候选提交时放行', () => {
    const box = sandbox('pass');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha)), { FAKE_GH_LOG: log });
    expect(result.output).toContain('pr-gate: ok');
    expect(result.code).toBe(0);
    expect(execFileSync('cat', [log], { encoding: 'utf8' })).toContain(
      'repos/example/repo/git/ref/heads/main',
    );
  });

  it('GitHub 上的分支已推进时拒绝，并给出实际远端 SHA', () => {
    const box = sandbox('ahead');
    const sha = box.sha();
    const moved = 'b'.repeat(40);
    box.remoteAt(moved);
    const result = box.run(args(sha, reports(box, sha)));
    expect(result.code).toBe(1);
    expect(result.output).toContain(moved);
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('GitHub 查询失败时拒绝，不回退到本地引用', () => {
    const box = sandbox('gh-fail');
    const sha = box.sha();
    const result = box.run(args(sha, reports(box, sha)), { FAKE_GH_FAIL: '1' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain('example/repo');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('同一份 code review 报告同时当 completion review 时拒绝', () => {
    const box = sandbox('roles');
    const sha = box.sha();
    box.remoteAt(sha);
    const { ci, code } = reports(box, sha);
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      code,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('completion review');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('仓库无法解析（没有 origin 也没给 --repo）时拒绝', () => {
    const box = sandbox('no-origin', { originUrl: null });
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha)));
    expect(result.code).toBe(1);
    expect(result.output).toContain('--repo');
  });

  it('--repo 格式不对时拒绝，不拿去查询', () => {
    const box = sandbox('bad-repo');
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha), ['--repo', 'not-a-slug']));
    expect(result.code).toBe(1);
    expect(result.output).toContain('owner/name');
  });

  it('游离 HEAD 未给 --branch 时拒绝', () => {
    const box = sandbox('detached');
    const sha = box.sha();
    box.remoteAt(sha);
    git(box.work, 'checkout', '-q', '--detach');
    const result = box.run(args(sha, reports(box, sha)));
    expect(result.code).toBe(1);
    expect(result.output).toContain('--branch');
  });

  it('游离 HEAD 给出 --branch 后按该分支查询并放行', () => {
    const box = sandbox('detached-branch');
    const sha = box.sha();
    box.remoteAt(sha);
    git(box.work, 'checkout', '-q', '--detach');
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha), ['--branch', 'main']), {
      FAKE_GH_LOG: log,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('pr-gate: ok');
    expect(execFileSync('cat', [log], { encoding: 'utf8' })).toContain('heads/main');
  });

  it('查询的是 --repo 与 --branch 指定的分支', () => {
    const box = sandbox('target');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(
      args(sha, reports(box, sha), ['--repo', 'other/name', '--branch', 'release']),
      {
        FAKE_GH_LOG: log,
      },
    );
    expect(result.code).toBe(0);
    const called = execFileSync('cat', [log], { encoding: 'utf8' });
    expect(called).toContain('repos/other/name/git/ref/heads/release');
  });

  it.each([
    'https://notgithub.com/example/repo.git',
    'https://enterprise.github.com/example/repo.git',
    'file:///tmp/github.com/example/repo.git',
    '/tmp/github.com/example/repo.git',
  ])('origin 不是 github.com 时拒绝并要求 --repo：%s', (originUrl) => {
    const box = sandbox(uniqueName('origin'), { originUrl });
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha)));
    expect(result.code).toBe(1);
    expect(result.output).toContain('--repo');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it.each([
    'https://github.com/example/repo.git/',
    'https://github.com/example/repo/',
    'git@github.com:example/repo.git',
    'git@GitHub.com:example/repo.git',
    'ssh://git@github.com/example/repo.git',
  ])('origin 形式可解析且查询 example/repo：%s', (originUrl) => {
    const box = sandbox(uniqueName('slug'), { originUrl });
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha)), { FAKE_GH_LOG: log });
    expect(result.code).toBe(0);
    expect(result.output).toContain('pr-gate: ok');
    expect(execFileSync('cat', [log], { encoding: 'utf8' })).toContain(
      'repos/example/repo/git/ref/heads/main',
    );
  });

  it('gh 不可执行时拒绝，不当作放行', () => {
    const box = sandbox('gh-missing');
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha)), {
      PR_GATE_GH: path.join(root, 'no-such-gh'),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('GitHub 返回的不是提交 SHA 时拒绝', () => {
    const box = sandbox('bad-sha');
    const sha = box.sha();
    writeFileSync(path.join(box.dir, 'sha.txt'), 'main\n');
    const result = box.run(args(sha, reports(box, sha)));
    expect(result.code).toBe(1);
    expect(result.output).toContain('不是提交 SHA');
  });

  it('分支名含斜杠时按原样查询', () => {
    const box = sandbox('slash-branch');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha), ['--branch', 'feat/nested/thing']), {
      FAKE_GH_LOG: log,
    });
    expect(result.code).toBe(0);
    expect(execFileSync('cat', [log], { encoding: 'utf8' })).toContain(
      'repos/example/repo/git/ref/heads/feat/nested/thing',
    );
  });

  it('分支名里的 # 会编码，不当作 URL fragment', () => {
    const box = sandbox('hash-branch');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha), ['--branch', 'release#candidate']), {
      FAKE_GH_LOG: log,
    });
    expect(result.code).toBe(0);
    const called = execFileSync('cat', [log], { encoding: 'utf8' });
    expect(called).toContain('heads/release%23candidate');
    expect(called).not.toContain('heads/release#');
  });

  it('显式 --repo 为空字符串时拒绝，且不查询', () => {
    const box = sandbox('empty-repo');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha), ['--repo', '']), { FAKE_GH_LOG: log });
    expect(result.code).toBe(1);
    expect(result.output).toContain('--repo');
    expect(existsSync(log)).toBe(false);
  });

  it('--branch 后面没有值时拒绝，不回退当前分支', () => {
    const box = sandbox('empty-branch');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha), ['--branch']), { FAKE_GH_LOG: log });
    expect(result.code).toBe(1);
    expect(result.output).toContain('--branch');
    expect(existsSync(log)).toBe(false);
  });

  it('host 带 DNS 尾点（github.com.）时仍可解析', () => {
    const box = sandbox('trailing-dot', { originUrl: 'git@github.com.:example/repo.git' });
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const result = box.run(args(sha, reports(box, sha)), { FAKE_GH_LOG: log });
    expect(result.code).toBe(0);
    expect(execFileSync('cat', [log], { encoding: 'utf8' })).toContain('repos/example/repo/');
  });

  it('拒绝 --repo=other/name 这种等号写法，且不查询', () => {
    const box = sandbox('equals-form');
    const sha = box.sha();
    box.remoteAt(sha);
    const log = path.join(box.dir, 'gh.log');
    const { ci, code, completion } = reports(box, sha);
    const result = box.run(
      [
        '--sha',
        sha,
        `--repo=example/repo`,
        '--ci',
        ci,
        '--code-review',
        code,
        '--completion-review',
        completion,
      ],
      { FAKE_GH_LOG: log },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('等号');
    expect(existsSync(log)).toBe(false);
  });

  it('重复参数时拒绝，不静默采用第一个', () => {
    const box = sandbox('duplicate-arg');
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha), ['--repo', 'example/repo', '--repo', '']));
    expect(result.code).toBe(1);
    expect(result.output).toContain('重复');
  });

  it('末尾单独 --sha 时拒绝，不回退 HEAD', () => {
    const box = sandbox('bare-sha');
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha), ['--sha']));
    expect(result.code).toBe(1);
    expect(result.output).toContain('--sha');
  });

  it('--sha 为空字符串时拒绝', () => {
    const box = sandbox('empty-sha');
    const sha = box.sha();
    box.remoteAt(sha);
    const { ci, code, completion } = reports(box, sha);
    const result = box.run(
      ['--sha', '', '--ci', ci, '--code-review', code, '--completion-review', completion],
      {},
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('--sha');
  });

  it('拒绝未知参数', () => {
    const box = sandbox('unknown-arg');
    const sha = box.sha();
    box.remoteAt(sha);
    const result = box.run(args(sha, reports(box, sha), ['--foo', 'bar']));
    expect(result.code).toBe(1);
    expect(result.output).toContain('--foo');
  });

  it('报告文件不存在时拒绝，并指出读不到哪个文件', () => {
    const box = sandbox('missing');
    const sha = box.sha();
    box.remoteAt(sha);
    const { code, completion } = reports(box, sha);
    const missing = path.join(root, 'missing.json');
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      missing,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain(missing);
  });

  it('报告文件内容不是合法 JSON 时拒绝', () => {
    const box = sandbox('broken');
    const sha = box.sha();
    box.remoteAt(sha);
    const { code, completion } = reports(box, sha);
    const broken = box.report('broken.json', '');
    writeFileSync(broken, '{ not json');
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      broken,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain(broken);
  });

  it('缺 completion review 参数时拒绝', () => {
    const box = sandbox('args');
    const sha = box.sha();
    box.remoteAt(sha);
    const { ci, code } = reports(box, sha);
    const result = box.run(['--sha', sha, '--ci', ci, '--code-review', code]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('completion review');
  });
});
