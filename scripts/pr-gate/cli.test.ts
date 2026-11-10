/**
 * pr-gate 入口的行为测试：在临时 Git 仓库里用真实参数跑 CLI，验证退出码与提示。
 * 判定细节在 `gate.test.ts`；这里覆盖入口才会踩到的坑：
 * 远端要查实际分支头（不是本地缓存的 upstream 引用），两份审查不能角色互换或缺输入。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const gateEntry = path.join(repoRoot, 'scripts', 'pr-gate.ts');

const root = mkdtempSync(path.join(os.tmpdir(), 'pr-gate-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=gate-test', '-c', 'user.email=gate@test', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** 一个带本地 bare 远端的工作克隆；回到同步状态后可继续提交。 */
function sandbox(name: string, remoteName = 'origin') {
  const dir = path.join(root, name);
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  git(dir, 'init', '--bare', '-q', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, work);
  if (remoteName !== 'origin') git(work, 'remote', 'rename', 'origin', remoteName);
  writeFileSync(path.join(work, 'file.txt'), 'base\n');
  git(work, 'add', 'file.txt');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', '-u', remoteName, 'main');

  return {
    dir,
    work,
    sha: () => git(work, 'rev-parse', 'HEAD'),
    advanceRemote() {
      const other = `${work}-other`;
      git(dir, 'clone', '-q', remote, other);
      writeFileSync(path.join(other, 'file.txt'), 'moved\n');
      git(other, 'add', 'file.txt');
      git(other, 'commit', '-q', '-m', 'moved');
      git(other, 'push', '-q', 'origin', 'main');
      return git(other, 'rev-parse', 'HEAD');
    },
    report(name: string, value: unknown) {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    },
    run(args: string[]) {
      try {
        const output = execFileSync(tsx, [gateEntry, ...args], {
          cwd: work,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, output };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      }
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

describe('pr-gate 入口', () => {
  it('CI 与两份审查都指向候选提交、远端也是它时放行', () => {
    const box = sandbox('pass');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.output).toContain('pr-gate: ok');
    expect(result.code).toBe(0);
  });

  it('远端已推进但本地没 fetch 时拒绝，不拿缓存的 upstream 当远端', () => {
    const box = sandbox('stale');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    box.advanceRemote();
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain('远端');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('同一份 code review 报告同时当 completion review 时拒绝', () => {
    const box = sandbox('roles');
    const sha = box.sha();
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

  it('远端存在 a/refs/heads/main 这类分支名时仍只认本分支', () => {
    const box = sandbox('suffix');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    // 干扰分支指向候选提交，远端 main 随后推进到别处，本地不 fetch。
    git(box.work, 'branch', 'a/refs/heads/main');
    git(box.work, 'push', '-q', 'origin', 'a/refs/heads/main');
    box.advanceRemote();
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('远端');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('远端名含斜杠时按配置解析并放行', () => {
    const box = sandbox('slash-remote', 'team/origin');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('pr-gate: ok');
  });

  it('已配置的上游分支在远端不存在时拒绝，不回退到 origin', () => {
    const box = sandbox('config-missing-branch');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    const pub = path.join(box.dir, 'pub.git');
    git(box.dir, 'init', '--bare', '-q', '-b', 'main', pub);
    git(box.work, 'remote', 'add', 'publish', pub);
    // 配置指向 publish 上并不存在的 release 分支：查询必然为空。
    git(box.work, 'config', 'branch.main.remote', 'publish');
    git(box.work, 'config', 'branch.main.merge', 'refs/heads/release');
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('已配置的上游不因查询失败回退');
  });

  it('上游指向本地仓库（remote 为 "."）时拒绝', () => {
    const box = sandbox('local-upstream');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    git(box.work, 'config', 'branch.main.remote', '.');
    git(box.work, 'config', 'branch.main.merge', 'refs/heads/main');
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('本地');
  });

  it('上游 merge 不是 refs/heads/* 时拒绝', () => {
    const box = sandbox('tag-upstream');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    git(box.work, 'tag', '-a', '-m', 'tag', 'candidate');
    git(box.work, 'config', 'branch.main.remote', 'origin');
    git(box.work, 'config', 'branch.main.merge', 'refs/tags/candidate');
    const result = box.run([
      '--sha',
      sha,
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('refs/heads/');
  });

  it('没有上游时可用 --remote 与 --remote-ref 指定远端分支', () => {
    const box = sandbox('detached');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    // 游离 HEAD：没有 branch.<名字>.remote/merge，也就没有 upstream 可查。
    git(box.work, 'checkout', '-q', '--detach');
    const result = box.run([
      '--sha',
      sha,
      '--remote',
      'origin',
      '--remote-ref',
      'refs/heads/main',
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('pr-gate: ok');
  });

  it('游离 HEAD 时远端已推进，给 --remote 与 --remote-ref 也拒绝', () => {
    const box = sandbox('detached-stale');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    git(box.work, 'checkout', '-q', '--detach');
    box.advanceRemote();
    const result = box.run([
      '--sha',
      sha,
      '--remote',
      'origin',
      '--remote-ref',
      'refs/heads/main',
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('远端');
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('只给 --remote 不给 --remote-ref 时拒绝', () => {
    const box = sandbox('half-remote');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    git(box.work, 'checkout', '-q', '--detach');
    const result = box.run([
      '--sha',
      sha,
      '--remote',
      'origin',
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('--remote-ref');
  });

  it('--remote 指定的远端头与候选不同时拒绝', () => {
    const box = sandbox('explicit');
    const sha = box.sha();
    const { ci, code, completion } = reports(box, sha);
    git(box.work, 'checkout', '-q', '--detach');
    box.advanceRemote();
    const result = box.run([
      '--sha',
      sha,
      '--remote',
      'origin',
      '--remote-ref',
      'refs/heads/main',
      '--ci',
      ci,
      '--code-review',
      code,
      '--completion-review',
      completion,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('远端');
  });

  it('报告文件不存在时拒绝，并指出读不到哪个文件', () => {
    const box = sandbox('missing');
    const sha = box.sha();
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

  it('报告文件内容不是合法 JSON 时拒绝，不放行也不静默当作缺失', () => {
    const box = sandbox('broken');
    const sha = box.sha();
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
    const { ci, code } = reports(box, sha);
    const result = box.run(['--sha', sha, '--ci', ci, '--code-review', code]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('completion review');
  });
});
