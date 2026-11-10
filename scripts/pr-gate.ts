/**
 * 开 PR 前的门禁入口。用法：
 *
 *   npm run pr:gate -- --sha <候选提交> \
 *     --ci <ci.json> --code-review <code.json> --completion-review <completion.json> \
 *     [--repo <owner/name>] [--branch <分支>]
 *
 * 报告格式见 `scripts/pr-gate/gate.ts` 的 `CiRecord` 与 `ReviewReport`。
 *
 * 远端分支头一律向 GitHub 查询（`gh api`），不用本地 git 配置推断“哪个才是远端”：
 * 本地 remote 可以写成 `./`、绝对路径、file URL 或别名，都能让某个本地引用冒充
 * “远端最新提交”。GitHub 上的分支头是 PR 看到的那一个，也是唯一可信的来源。
 * 查询失败（无登录态、分支不存在、网络不可达）一律拒绝，不回退。
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
 * 从 origin 的 URL 取 GitHub 仓库。主机必须正好是 github.com：
 * `notgithub.com`、`enterprise.github.com`、本地路径都不是 GitHub，
 * 猜成同名仓库会去查错目标，所以一律要求显式 `--repo`。
 */
function githubSlug(url: string): string {
  const raw = url.trim();
  if (!raw) return '';

  let host: string;
  let pathname: string;

  // git@github.com:owner/repo.git 这类 scp 风格地址，URL 构造器解析不了。
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes('://')) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return '';
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return '';
    host = parsed.hostname;
    pathname = parsed.pathname;
  }

  if (host.toLowerCase() !== 'github.com') return '';

  const cleaned = pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  return `${parts[0]}/${parts[1]}`;
}

type Target = { repo: string; branch: string; error?: string };

/** 目标仓库与分支。任何一项定不下来就拒绝，不用默认值猜。 */
function resolveTarget(repoArg?: string, branchArg?: string): Target {
  const errors: string[] = [];

  let repo = '';
  if (repoArg) {
    if (/^[^/\s]+\/[^/\s]+$/.test(repoArg)) repo = repoArg;
    else errors.push(`--repo 需为 owner/name：${repoArg}`);
  } else {
    repo = githubSlug(git(['remote', 'get-url', 'origin']));
    if (!repo) errors.push('无法从 origin 解析 GitHub 仓库，请用 --repo owner/name');
  }

  let branch = branchArg ?? '';
  if (!branch) {
    const current = currentBranch();
    if (current && current !== 'HEAD') branch = current;
    else errors.push('游离 HEAD 无法确定分支，请用 --branch 指定');
  }

  return { repo, branch, ...(errors.length ? { error: errors.join('；') } : {}) };
}

type RemoteHead = { sha: string; error?: string };

/** GitHub 上该分支的实际头。查询失败不返回 SHA，让门禁拒绝。 */
function remoteHead(repo: string, branch: string): RemoteHead {
  const gh = process.env.PR_GATE_GH || 'gh';
  const refPath = `repos/${repo}/git/ref/heads/${branch}`;
  try {
    const output = execFileSync(gh, ['api', refPath, '--jq', '.object.sha'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(output)) return { sha: output };
    return {
      sha: '',
      error: `GitHub 返回的 ${repo} ${branch} 分支头不是提交 SHA：${output || '(空)'}`,
    };
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? '')
      .trim()
      .split('\n')[0];
    return {
      sha: '',
      error: `查不到 ${repo} 的 ${branch} 分支（gh api ${refPath} 失败${detail ? `：${detail}` : ''}）`,
    };
  }
}

const sha = arg('sha') ?? git(['rev-parse', 'HEAD']);
const target = resolveTarget(arg('repo'), arg('branch'));
const head = target.error
  ? { sha: '', error: target.error }
  : remoteHead(target.repo, target.branch);

const ci = readJson<CiRecord>('CI', arg('ci'));
const code = readJson<ReviewReport>('code review', arg('code-review'));
const completion = readJson<ReviewReport>('completion review', arg('completion-review'));

const result = evaluateGate({
  sha,
  headSha: git(['rev-parse', 'HEAD']),
  remoteSha: head.sha,
  ci: ci.value,
  codeReview: code.value,
  completionReview: completion.value,
});

const failures = [ci.error, code.error, completion.error, head.error].filter(
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
