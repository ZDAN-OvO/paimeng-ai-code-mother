/**
 * 开 PR 前的门禁入口。用法：
 *
 *   npm run pr:gate -- --sha <候选提交> \
 *     --ci <ci.json> --code-review <code.json> --completion-review <completion.json> \
 *     [--remote <远端名> --remote-ref <refs/heads/分支>]
 *
 * 报告格式见 `scripts/pr-gate/gate.ts` 的 `CiRecord` 与 `ReviewReport`。
 *
 * 远端头一律向远端查询（`git ls-remote`），不接受调用者直接给一个 SHA：
 * 那样等于把“远端到底在哪”交给调用者，正好绕开本门禁要防的事。
 * 没有上游配置时用 `--remote` 与 `--remote-ref` 指出远端分支，仍然实际查询；
 * 已配置但查不到（tracking ref 缺失、分支被删、远端不可达）一律拒绝，不回退。
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
    if (name?.trim() === ref) return sha.trim();
  }
  return '';
}

/**
 * 上游必须是可查询的远端分支：本地上游（`remote` 为 `.`）和 tag 等非分支 ref
 * 都能让本地某个引用冒充“远端最新提交”，不能作为门禁依据。
 */
function validateTarget(remote: string, ref: string): string | undefined {
  if (!remote) return '远端名为空';
  if (remote === '.') return '不支持本地仓库作为上游（remote 为 "."），请给出可查询的远端名';
  if (!ref) return '上游分支为空';
  if (!ref.startsWith('refs/heads/')) return `上游 ref ${ref} 不是分支（应 refs/heads/*）`;
  if (ref === 'refs/heads/') return '上游 ref 缺少分支名';
  return undefined;
}

/** 上游的远端与 ref。取 `git config branch.<名字>.remote/merge`，不拆 `@{upstream}` 的显示串。 */
function upstreamTarget(): { remote: string; ref: string } | null {
  const branch = currentBranch();
  if (!branch || branch === 'HEAD') return null;
  const remote = git(['config', '--get', `branch.${branch}.remote`]);
  const ref = git(['config', '--get', `branch.${branch}.merge`]);
  return remote && ref ? { remote, ref } : null;
}

type Resolution = {
  sha: string;
  source: string;
  /** 目标来自分支配置（查不到也不能回退）还是调用者的显式指定。 */
  mode: 'configured' | 'fallback';
  error?: string;
};

function resolveRemote(remoteArg?: string, refArg?: string): Resolution {
  const upstream = upstreamTarget();
  if (upstream) {
    const source = `${upstream.remote} 的 ${upstream.ref}`;
    const invalid = validateTarget(upstream.remote, upstream.ref);
    if (invalid) return { sha: '', source, mode: 'configured', error: `上游配置无效：${invalid}` };
    return { sha: remoteHead(upstream.remote, upstream.ref), source, mode: 'configured' };
  }

  const branch = currentBranch();
  if (branch && branch !== 'HEAD') {
    const ref = `refs/heads/${branch}`;
    const sha = remoteHead('origin', ref);
    if (sha) return { sha, source: `origin 的 ${ref}`, mode: 'fallback' };
  }

  if (remoteArg || refArg) {
    if (!remoteArg || !refArg) {
      return {
        sha: '',
        source: '--remote/--remote-ref',
        mode: 'fallback',
        error: '--remote 与 --remote-ref 必须同时给',
      };
    }
    const source = `${remoteArg} 的 ${refArg}`;
    const invalid = validateTarget(remoteArg, refArg);
    if (invalid) return { sha: '', source, mode: 'fallback', error: invalid };
    return { sha: remoteHead(remoteArg, refArg), source, mode: 'fallback' };
  }

  return {
    sha: '',
    source: '远端分支',
    mode: 'fallback',
    error: '没有上游配置，也没有给出 --remote 与 --remote-ref',
  };
}

const sha = arg('sha') ?? git(['rev-parse', 'HEAD']);
const remote = resolveRemote(arg('remote'), arg('remote-ref'));

const ci = readJson<CiRecord>('CI', arg('ci'));
const code = readJson<ReviewReport>('code review', arg('code-review'));
const completion = readJson<ReviewReport>('completion review', arg('completion-review'));

const result = evaluateGate({
  sha,
  headSha: git(['rev-parse', 'HEAD']),
  remoteSha: remote.sha,
  ci: ci.value,
  codeReview: code.value,
  completionReview: completion.value,
});

const failures = [ci.error, code.error, completion.error].filter(
  (failure): failure is string => !!failure,
);

if (!remote.sha) {
  failures.push(
    remote.error ??
      (remote.mode === 'configured'
        ? `查不到${remote.source}的实际头，已配置的上游不因查询失败回退`
        : `查不到${remote.source}的实际头，请检查远端与分支`),
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
