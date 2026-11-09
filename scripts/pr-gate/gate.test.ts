import { describe, expect, it } from 'vitest';
import { evaluateGate, type GateInput, type ReviewReport } from './gate';

const SHA = 'a'.repeat(40);

const passed: ReviewReport = {
  sha: SHA,
  reviewer: 'reviewer',
  model: 'xhy-api/gpt-6.1-sol',
  verdict: 'passed',
};

const completionPassed: ReviewReport = {
  sha: SHA,
  reviewer: 'completion',
  model: 'auto/glm-5.3-flash',
  verdict: 'passed',
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    sha: SHA,
    headSha: SHA,
    remoteSha: SHA,
    ci: { headSha: SHA, conclusion: 'success' },
    codeReview: passed,
    completionReview: completionPassed,
    ...overrides,
  };
}

describe('evaluateGate', () => {
  it('CI、两份 review、HEAD 与远端都指向同一提交时放行', () => {
    const result = evaluateGate(input());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('CI 未通过时拒绝，并说明原因', () => {
    const result = evaluateGate(input({ ci: { headSha: SHA, conclusion: 'failure' } }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('CI');
  });

  it('CI 跑在别的提交上时拒绝', () => {
    const result = evaluateGate(input({ ci: { headSha: 'b'.repeat(40), conclusion: 'success' } }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('CI');
  });

  it('缺少 completion review 时拒绝', () => {
    const result = evaluateGate(input({ completionReview: null }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('completion review');
  });

  it('review 被审的 SHA 与候选提交不同时拒绝', () => {
    const stale: ReviewReport = { ...passed, sha: 'c'.repeat(40) };
    const result = evaluateGate(input({ codeReview: stale }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('code review');
  });

  it('review 结论为打回时拒绝', () => {
    const rejected: ReviewReport = { ...passed, verdict: 'changes_requested' };
    const result = evaluateGate(input({ codeReview: rejected }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('code review');
  });

  it('本地 HEAD 与远端最新提交不一致时拒绝', () => {
    const result = evaluateGate(input({ remoteSha: 'd'.repeat(40) }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('远端');
  });
});
