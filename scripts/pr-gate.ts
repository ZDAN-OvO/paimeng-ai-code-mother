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

const FLAGS = new Set(['sha', 'ci', 'code-review', 'completion-review', 'repo', 'branch']);

/**
 * 一次性解析所有参数。只接受 `--名字 值` 的分隔写法：
 * - `--名字=值` 直接拒绝，避免一半代码认这种写法、一半不认；
 * - 重复、未知、缺值（含末尾裸参数）都拒绝，不靠“取第一个出现的值”蒙混；
 * - “没传”和“传了空值”必须分得开，否则显式空目标会悄悄回退默认值。
 */
function parseArgs(argv: string[]): { values: Map<string, string>; error?: string } {
  const values = new Map<string, string>();
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      errors.push(`无法识别的参数：${token}`);
      continue;
    }
    const name = token.slice(2);
    if (name.includes('=')) {
      errors.push(`不支持等号写法 ${token}，请用 --${name.split('=')[0]} 值`);
      continue;
    }
    if (!FLAGS.has(name)) {
      errors.push(`未知参数：${token}`);
      continue;
    }
    if (values.has(name)) {
      errors.push(`参数重复：${token}`);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(`${token} 需要值`);
      continue;
    }
    values.set(name, next);
    index += 1;
  }

  return { values, ...(errors.length ? { error: errors.join('；') } : {}) };
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

  // DNS 允许主机名带结尾点，`github.com.` 与 `github.com` 是同一主机。
  if (host.toLowerCase().replace(/\.$/, '') !== 'github.com') return '';

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
function resolveTarget(
  repoArg: { present: boolean; value: string },
  branchArg: { present: boolean; value: string },
): Target {
  const errors: string[] = [];

  let repo = '';
  if (repoArg.present) {
    if (!repoArg.value) errors.push('--repo 需要值（owner/name）');
    else if (/^[^/\s]+\/[^/\s]+$/.test(repoArg.value)) repo = repoArg.value;
    else errors.push(`--repo 需为 owner/name：${repoArg.value}`);
  } else {
    repo = githubSlug(git(['remote', 'get-url', 'origin']));
    if (!repo) errors.push('无法从 origin 解析 GitHub 仓库，请用 --repo owner/name');
  }

  let branch = '';
  if (branchArg.present) {
    if (!branchArg.value) errors.push('--branch 需要值');
    else branch = branchArg.value;
  } else {
    const current = currentBranch();
    if (current && current !== 'HEAD') branch = current;
    else errors.push('游离 HEAD 无法确定分支，请用 --branch 指定');
  }

  return { repo, branch, ...(errors.length ? { error: errors.join('；') } : {}) };
}

type RemoteHead = { sha: string; error?: string };

/** 分支按路径段编码，保留 `/` 分隔；否则 `#` 会被当成 URL fragment 截断。 */
function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** GitHub 上该分支的实际头。查询失败不返回 SHA，让门禁拒绝。 */
function remoteHead(repo: string, branch: string): RemoteHead {
  const gh = process.env.PR_GATE_GH || 'gh';
  const refPath = `repos/${repo}/git/ref/heads/${encodeBranch(branch)}`;
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

const parsed = parseArgs(process.argv.slice(2));
const shaArg = parsed.values.get('sha');

const failures: string[] = [];
if (parsed.error) failures.push(parsed.error);
if (shaArg === '') failures.push('--sha 需要值');

const target = resolveTarget(
  { present: parsed.values.has('repo'), value: parsed.values.get('repo') ?? '' },
  { present: parsed.values.has('branch'), value: parsed.values.get('branch') ?? '' },
);

let head: RemoteHead = { sha: '' };
if (parsed.error) {
  // 参数本身不合法时不再查询，避免拿默认目标“碰巧”放行。
} else if (target.error) {
  failures.push(target.error);
} else {
  head = remoteHead(target.repo, target.branch);
  if (head.error) failures.push(head.error);
}

const sha = shaArg || git(['rev-parse', 'HEAD']);

const ci = readJson<CiRecord>('CI', parsed.values.get('ci'));
const code = readJson<ReviewReport>('code review', parsed.values.get('code-review'));
const completion = readJson<ReviewReport>(
  'completion review',
  parsed.values.get('completion-review'),
);

const result = evaluateGate({
  sha,
  headSha: git(['rev-parse', 'HEAD']),
  remoteSha: head.sha,
  ci: ci.value,
  codeReview: code.value,
  completionReview: completion.value,
});

for (const report of [ci, code, completion]) {
  if (report.error) failures.push(report.error);
}

const all = [...failures, ...result.failures];

if (all.length === 0) {
  console.log(`pr-gate: ok（候选提交 ${sha}）`);
} else {
  console.error('pr-gate: 拒绝开 PR');
  for (const failure of all) console.error(`- ${failure}`);
  process.exit(1);
}
