/**
 * 开 PR 前的门禁入口。用法：
 *
 *   npm run pr:gate -- --sha <候选提交> \
 *     --ci <ci.json> --code-review <code.json> --completion-review <completion.json>
 *
 * 报告格式见 `scripts/pr-gate/gate.ts` 的 `CiRecord` 与 `ReviewReport`。
 * 远端分支默认取当前分支的上游；没有上游时用 `--remote <sha>` 直接给。
 *
 * 读不到或读不懂报告一律拒绝：缺输入不等于通过，也不把解析失败当成“没有报告”。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateGate, type CiRecord, type ReviewReport } from './pr-gate/gate';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

type Report<T> = { value: T | null; error?: string };

function readJson<T>(label: string, file: string | undefined): Report<T> {
  if (!file) return { value: null };
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) as T };
  } catch (error) {
    return {
      value: null,
      error: `读取 ${label} 报告失败（${file}）：${(error as Error).message.split('\n')[0]}`,
    };
  }
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

const ci = readJson<CiRecord>('CI', arg('ci'));
const code = readJson<ReviewReport>('code review', arg('code-review'));
const completion = readJson<ReviewReport>('completion review', arg('completion-review'));

const result = evaluateGate({
  sha,
  headSha: gitSha('HEAD'),
  remoteSha,
  ci: ci.value,
  codeReview: code.value,
  completionReview: completion.value,
});

const failures = [ci.error, code.error, completion.error].filter(
  (failure): failure is string => !!failure,
);
const all = [...failures, ...result.failures];

if (all.length === 0) {
  console.log(`pr-gate: ok（候选提交 ${sha}）`);
} else {
  console.error('pr-gate: 拒绝开 PR');
  for (const failure of all) console.error(`- ${failure}`);
  process.exit(1);
}
