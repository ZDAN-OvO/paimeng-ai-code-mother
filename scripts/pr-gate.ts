/**
 * 开 PR 前的门禁入口。用法：
 *
 *   npm run pr:gate -- --sha <候选提交> \
 *     --ci <ci.json> --code-review <code.json> --completion-review <completion.json>
 *
 * 报告格式见 `scripts/pr-gate/gate.ts` 的 `CiRecord` 与 `ReviewReport`。
 * 远端分支默认取当前分支的上游；没有上游时用 `--remote <sha>` 直接给。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateGate, type CiRecord, type ReviewReport } from './pr-gate/gate';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(path: string | undefined): T | null {
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function gitSha(rev: string): string {
  try {
    return execFileSync('git', ['rev-parse', rev], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const sha = arg('sha') ?? gitSha('HEAD');
const remoteSha = arg('remote') ?? gitSha('@{upstream}');

const result = evaluateGate({
  sha,
  headSha: gitSha('HEAD'),
  remoteSha,
  ci: readJson<CiRecord>(arg('ci')),
  codeReview: readJson<ReviewReport>(arg('code-review')),
  completionReview: readJson<ReviewReport>(arg('completion-review')),
});

if (result.ok) {
  console.log(`pr-gate: ok（候选提交 ${sha}）`);
} else {
  console.error('pr-gate: 拒绝开 PR');
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exit(1);
}
