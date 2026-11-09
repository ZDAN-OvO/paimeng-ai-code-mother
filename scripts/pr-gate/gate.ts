/**
 * 开 PR 前的门禁判定。
 *
 * 只核对同一件事：CI、两份 review、本地 HEAD 与远端分支是否都指向同一个候选提交。
 * 顺序、证据清单等其他规则等真实发生违规时再加，每加一条先写一条会失败的测试。
 */

export type ReviewVerdict = 'passed' | 'changes_requested';

/** 一份独立审查的报告。`sha` 是被审的候选提交，不是报告生成时的 HEAD。 */
export type ReviewReport = {
  sha: string;
  reviewer: string;
  model: string;
  verdict: ReviewVerdict;
};

/** 一次远端 CI 运行。`headSha` 是这次运行实际构建的提交。 */
export type CiRecord = {
  headSha: string;
  conclusion: string;
};

export type GateInput = {
  /** 本轮准备开 PR 的候选提交。 */
  sha: string;
  /** 本地 HEAD。 */
  headSha: string;
  /** 远端功能分支最新提交。 */
  remoteSha: string;
  ci: CiRecord | null;
  codeReview: ReviewReport | null;
  completionReview: ReviewReport | null;
};

export type GateResult = { ok: boolean; failures: string[] };

function checkReview(label: string, report: ReviewReport | null, sha: string, failures: string[]) {
  if (!report) {
    failures.push(`缺少 ${label} 报告`);
    return;
  }
  if (report.sha !== sha) {
    failures.push(`${label} 审查的是 ${report.sha}，不是候选提交 ${sha}`);
    return;
  }
  if (report.verdict !== 'passed') {
    failures.push(`${label} 结论是 ${report.verdict}`);
  }
}

export function evaluateGate(input: GateInput): GateResult {
  const failures: string[] = [];
  const { sha, headSha, remoteSha, ci, codeReview, completionReview } = input;

  if (!sha) return { ok: false, failures: ['没有指定候选提交'] };

  if (!ci) {
    failures.push('缺少 CI 记录');
  } else if (ci.conclusion !== 'success') {
    failures.push(`CI 结论是 ${ci.conclusion || '(空)'}，不是 success`);
  } else if (ci.headSha !== sha) {
    failures.push(`CI 跑在 ${ci.headSha}，不是候选提交 ${sha}`);
  }

  checkReview('code review', codeReview, sha, failures);
  checkReview('completion review', completionReview, sha, failures);

  if (headSha !== sha) failures.push(`本地 HEAD 是 ${headSha}，不是候选提交 ${sha}`);
  if (remoteSha !== sha) failures.push(`远端分支是 ${remoteSha}，不是候选提交 ${sha}`);

  return { ok: failures.length === 0, failures };
}
