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

function currentBranch(): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * 远端分支的实际头。按 ref 字段完全相等匹配，不做后缀比较：
 * 名为 `a/refs/heads/main` 的分支会让后缀匹配把 `main` 认错。
 */
function remoteHead(remote: string, ref: string): string {
  const output = git(['ls-remote', remote, ref]);
  for (const line of output.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref) return sha.trim();
  }
  return '';
}

/**
 * 上游的远端与 ref。取 `git config branch.<名字>.remote/merge`，
 * 不拆 `@{upstream}` 的显示串：远端名本身可以含斜杠（如 `team/origin`）。
 */
function upstreamTarget(): { remote: string; ref: string } | null {
  const branch = currentBranch();
  if (!branch || branch === 'HEAD') return null;
  const remote = git(['config', '--get', `branch.${branch}.remote`]);
  const ref = git(['config', '--get', `branch.${branch}.merge`]);
  return remote && ref ? { remote, ref } : null;
}

/**
 * 远端实际头。`unconfigured` 表示确实没有上游配置，只有这种情况才允许 `--remote` 兜底；
 * 已配置但查不到（tracking ref 缺失、分支被删、远端不可达）一律拒绝，不回退。
 */
function resolveRemote(): { sha: string; source: string; unconfigured: boolean } {
  const upstream = upstreamTarget();
  if (upstream) {
    return {
      sha: remoteHead(upstream.remote, upstream.ref),
      source: `${upstream.remote} 的 ${upstream.ref}`,
      unconfigured: false,
    };
  }

  const branch = currentBranch();
  if (branch && branch !== 'HEAD') {
    const ref = `refs/heads/${branch}`;
    const sha = remoteHead('origin', ref);
    if (sha) return { sha, source: `origin 的 ${ref}`, unconfigured: true };
  }

  return { sha: '', source: '远端分支', unconfigured: true };
}

const sha = arg('sha') ?? git(['rev-parse', 'HEAD']);
const explicitRemote = arg('remote');
const remote = resolveRemote();
const remoteSha = remote.sha || (remote.unconfigured ? explicitRemote : '') || '';

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
if (!remoteSha) {
  failures.push(
    remote.unconfigured
      ? `查不到${remote.source}的实际头；没有上游配置时可用 --remote 指定`
      : `查不到${remote.source}的实际头，已配置的上游不因查询失败回退`,
  );
}

const all = [...failures, ...result.failures];

if (all.length === 0) {
  console.log(`pr-gate: ok（候选提交 ${sha}）`);
} else {
  console.error('pr-gate: 拒绝开 PR');
  for (const failure of all) console.error(`- ${failure}`);
  process.exit(1);
}
