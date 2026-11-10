/**
 * pr-gate 入口的行为测试：用真实的命令行参数与报告文件跑一次，验证退出码与提示。
 * 判定逻辑的细节在 `gate.test.ts`；这里只保证入口没有把“缺输入”变成“通过”。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const dir = mkdtempSync(path.join(os.tmpdir(), 'pr-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function report(name: string, value: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const ci = () => report('ci.json', { headSha: sha, conclusion: 'success' });
const codeReview = () =>
  report('code.json', { sha, reviewer: 'code', model: 'xhy-api/gpt-6.1-sol', verdict: 'passed' });
const completionReview = () =>
  report('completion.json', {
    sha,
    reviewer: 'completion',
    model: 'auto/glm-5.3-flash',
    verdict: 'passed',
  });

/** 直接执行 CLI，返回退出码与合并后的输出。 */
function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/pr-gate.ts', '--sha', sha, '--remote', sha, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

describe('pr-gate 入口', () => {
  it('同一提交、CI 与两份审查都通过时放行', () => {
    const result = run([
      '--ci',
      ci(),
      '--code-review',
      codeReview(),
      '--completion-review',
      completionReview(),
    ]);
    expect(result.output).toContain('pr-gate: ok');
    expect(result.code).toBe(0);
  });

  it('报告文件不存在时拒绝，并指出读不到哪个文件', () => {
    const missing = path.join(dir, 'missing.json');
    const result = run([
      '--ci',
      missing,
      '--code-review',
      codeReview(),
      '--completion-review',
      completionReview(),
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain(missing);
    expect(result.output).not.toContain('pr-gate: ok');
  });

  it('报告文件内容不是合法 JSON 时拒绝，不放行也不静默当作缺失', () => {
    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    const result = run([
      '--ci',
      broken,
      '--code-review',
      codeReview(),
      '--completion-review',
      completionReview(),
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('拒绝开 PR');
    expect(result.output).toContain(broken);
  });

  it('缺 completion review 参数时拒绝', () => {
    const result = run(['--ci', ci(), '--code-review', codeReview()]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('completion review');
  });
});
