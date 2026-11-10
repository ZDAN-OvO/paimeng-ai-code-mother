/**
 * 开 PR 前的门禁入口。用法：
 *
 *   npm run pr:gate -- --sha <候选提交> \
 *     --ci <ci.json> --code-review <code.json> --completion-review <completion.json>
 *
 * 报告格式见 `scripts/pr-gate/gate.ts` 的 `CiRecord` 与 `ReviewReport`。
 *
 * 远端头一律向远端查询（`git ls-remote`），不读本地缓存的 upstream 引用：
 * 那个引用在未 fetch 时会停留在旧提交，正好会把过期候选判成“与远端一致”。
 * `--remote` 只用于没有 upstream 的游离分支；给了却与远端实际头不一致时拒绝。
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

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** 远端分支的实际头。`origin/feat/x` → `git ls-remote --heads origin feat/x`。 */
function remoteHead(ref: string): string {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return '';
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  const output = git(['ls-remote', '--heads', remote, branch]);
  const row = output.split('\n').find((line) => line.endsWith(`refs/heads/${branch}`));
  return row ? row.split('\t')[0].trim() : '';
}

/** 当前分支上游的远端实际头；没有 upstream 时用 origin/<当前分支>，再不行交给 --remote。 */
function resolveRemote(): { sha: string; source: string } {
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) return { sha: remoteHead(upstream), source: `远端 ${upstream}` };

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') {
    const guess = `origin/${branch}`;
    const sha = remoteHead(guess);
    if (sha) return { sha, source: `远端 ${guess}` };
  }

  return { sha: '', source: '远端分支' };
}

const sha = arg('sha') ?? git(['rev-parse', 'HEAD']);
const explicitRemote = arg('remote');
const remote = resolveRemote();
const remoteSha = remote.sha || explicitRemote || '';

const ci = readJson<CiRecord>('CI', arg('ci'));
const code = readJson<ReviewReport>('code review', arg('code-review'));
const completion = readJson<ReviewReport>('completion review', arg('completion-review'));

const result = evaluateGate({
  sha,
  headSha: git(['rev-parse', 'HEAD']),
  remoteSha,
  ci: ci.value,
  codeReview: code.value,
  completionReview: completion.value,
});

const failures = [ci.error, code.error, completion.error].filter(
  (failure): failure is string => !!failure,
);

if (explicitRemote && remote.sha && explicitRemote !== remote.sha) {
  failures.push(`显式 --remote ${explicitRemote} 与${remote.source}的 ${remote.sha} 不一致`);
}
if (!remote.sha) {
  failures.push(`查不到${remote.source}的实际头：分支不存在或未配置远端（可用 --remote 指定）`);
}

const all = [...failures, ...result.failures];

if (all.length === 0) {
  console.log(`pr-gate: ok（候选提交 ${sha}）`);
} else {
  console.error('pr-gate: 拒绝开 PR');
  for (const failure of all) console.error(`- ${failure}`);
  process.exit(1);
}
