#!/usr/bin/env node
// 检查 docs/ 与代码的结构一致性：route 与 api.md 表格、13 条验收路径、明确不做清单。
// 只做结构比对，不判断语义真假；「未检」不算失败。
// 用法：node scripts/check-docs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API_DOC = 'docs/api.md';
const MVP = 'docs/mvp.md';
const ARCH = 'docs/architecture.md';
const ROUTES_DIR = 'src/app/api';
const EVIDENCE_DIR = 'docs/evidence';
const INDEX = 'docs/evidence/INDEX.md';

const problems = [];
const fail = (file, line, message, rule) => problems.push({ file, line, message, rule });

const read = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/);
const cells = (raw) =>
  raw
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** 目录里的 route.ts 路径转成契约路径：`[id]` → `:id`。 */
function routePath(file) {
  const rel = path.relative(ROUTES_DIR, path.dirname(file));
  const segments = rel === '' ? [] : rel.split(path.sep);
  const parts = segments.map((s) =>
    s.startsWith('[') && s.endsWith(']') ? `:${s.slice(1, -1)}` : s,
  );
  return `/api/${parts.join('/')}`.replace(/\/$/, '');
}

function routeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

/** route.ts 导出的 HTTP 方法。`export const dynamic` 之类不算。 */
function routeMethods(file) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PATCH|PUT|DELETE)\b/g;
  const found = new Set();
  for (const match of text.matchAll(re)) found.add(match[1]);
  return [...found];
}

const normalize = (route) => route.replace(/:[^/]+/g, ':*');

/** api.md 表格里的 `方法 | 路径` 行；路径里的查询串不参与比对。 */
function docRoutes() {
  const lines = read(API_DOC);
  const out = [];
  lines.forEach((raw, i) => {
    const m = raw.match(/^\|\s*`(GET|POST|PATCH|PUT|DELETE)`\s*\|\s*`(\/api\/[^`]+)`/);
    if (m) out.push({ method: m[1], route: m[2].split('?')[0], line: i + 1 });
  });
  return out;
}

function checkRoutes() {
  const code = new Map();
  for (const file of routeFiles(ROUTES_DIR)) {
    const route = routePath(file);
    for (const method of routeMethods(file))
      code.set(`${method} ${normalize(route)}`, { method, route, file });
  }

  const doc = new Map();
  for (const entry of docRoutes()) {
    const key = `${entry.method} ${normalize(entry.route)}`;
    if (doc.has(key))
      fail(API_DOC, entry.line, `${entry.method} ${entry.route} 重复出现`, 'route-duplicate');
    doc.set(key, entry);
  }

  for (const [key, entry] of code) {
    if (!doc.has(key)) {
      fail(
        API_DOC,
        1,
        `${entry.method} ${entry.route} 在代码里存在（${entry.file}），契约没有写`,
        'route-missing-doc',
      );
    }
  }
  for (const [key, entry] of doc) {
    if (!code.has(key)) {
      fail(
        API_DOC,
        entry.line,
        `${entry.method} ${entry.route} 写进了契约，但没有对应的 route handler`,
        'route-missing-code',
      );
    }
  }

  // 同一个位置的参数只能用同一个名字：`/api/deploys/:id/events` 与 `/api/deploys/:deployKey` 指同一个东西
  const names = new Map();
  for (const entry of doc.values()) {
    const segments = entry.route.split('/');
    segments.forEach((segment, index) => {
      if (!segment.startsWith(':')) return;
      const prefix = segments.slice(0, index).join('/');
      const key = `${prefix}/*`;
      const seen = names.get(key) ?? new Set();
      seen.add(segment.slice(1));
      names.set(key, seen);
    });
  }
  for (const [key, seen] of names) {
    if (seen.size > 1) {
      fail(API_DOC, 1, `${key} 的参数名不统一：${[...seen].join(' / ')}`, 'param-name');
    }
  }
  return { code, doc };
}

/** 两份文档里 `| N | 能力 | 演示路径 |` 形式的 13 条。 */
function acceptanceRows(file, heading) {
  const lines = read(file);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) {
    fail(file, 1, `找不到 "${heading}"，无法比对 13 条`, 'acceptance-heading');
    return new Map();
  }
  const rows = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) break;
    if (!line.startsWith('|')) continue;
    const c = cells(line);
    if (!/^\d+$/.test(c[0])) continue;
    rows.set(Number(c[0]), { name: c[1], path: c[2], line: i + 1, file });
  }
  return rows;
}

function checkAcceptance() {
  const mvp = acceptanceRows(MVP, '## 2. MVP 范围');
  const arch = acceptanceRows(ARCH, '## 2. 交付范围');
  const ids = new Set([...mvp.keys(), ...arch.keys()]);
  for (const id of [...ids].sort((a, b) => a - b)) {
    const a = mvp.get(id);
    const b = arch.get(id);
    if (!a || !b) {
      fail(b?.file ?? a.file, (b ?? a).line, `第 ${id} 条只在一份文档里出现`, 'acceptance-missing');
      continue;
    }
    if (a.name !== b.name) {
      fail(
        ARCH,
        b.line,
        `第 ${id} 条的能力名不一致：mvp「${a.name}」/ architecture「${b.name}」`,
        'acceptance-name',
      );
    }
    const strip = (s) => s.replace(/\s+/g, '');
    if (strip(a.path) !== strip(b.path)) {
      fail(
        ARCH,
        b.line,
        `第 ${id} 条的演示路径不一致：mvp「${a.path}」/ architecture「${b.path}」`,
        'acceptance-path',
      );
    }
  }
}

/** 证据索引：「通过 / 过期 / 未检」由这里算，不靠手写。 */
function checkEvidence() {
  const stats = { passed: 0, stale: 0, unchecked: 0 };
  if (!fs.existsSync(INDEX)) {
    fail(EVIDENCE_DIR, 1, '缺少证据索引', 'evidence-index');
    return stats;
  }
  if (gitOk('rev-parse --is-shallow-repository') === 'true') {
    fail(
      INDEX,
      1,
      '仓库是浅克隆，无法判断证据新鲜度；CI 的 checkout 需要 fetch-depth: 0',
      'shallow',
    );
  }

  const lines = read(INDEX);
  const tables = { contract: [], ui: [], retired: [] };
  let section = '';
  lines.forEach((raw, i) => {
    const h2 = raw.match(/^## (.+?)\s*$/);
    if (h2) {
      section = h2[1];
      return;
    }
    if (!raw.trim().startsWith('|')) return;
    const bucket = section.startsWith('交付证据')
      ? tables.contract
      : section.startsWith('界面证据')
        ? tables.ui
        : section.startsWith('过期与退役')
          ? tables.retired
          : null;
    if (!bucket) return;
    // 表头与分隔行不参与比对
    if (cells(raw).every((c) => /^:?-{3,}:?$/.test(c))) {
      if (bucket.length > 0) bucket.pop();
      return;
    }
    bucket.push({ cells: cells(raw), line: i + 1 });
  });

  // 21 条一条不能少
  const expected = [
    ...Array.from({ length: 13 }, (_, i) => String(i + 1)),
    ...Array.from({ length: 8 }, (_, i) => `2.1.${i + 1}`),
  ];
  const got = new Set(tables.contract.map((r) => r.cells[0]));
  for (const id of expected)
    if (!got.has(id)) fail(INDEX, 1, `交付证据缺第 ${id} 条`, 'evidence-row');
  for (const id of got)
    if (!expected.includes(id))
      fail(INDEX, 1, `交付证据多出「${id}」，13 条与 2.1 里没有`, 'evidence-row');

  const filed = new Set();
  const clean = (v) => (v === '—' || v === '' ? '' : v.trim());
  const unquote = (v) => v.replace(/`/g, '').replace(/\/$/, '');

  const freshness = (dir, globs, sha, line) => {
    if (!fs.existsSync(dir)) return fail(INDEX, line, `证据目录不存在：${dir}`, 'evidence-missing');
    if (!fs.existsSync(path.join(dir, 'README.md')))
      return fail(INDEX, line, `${dir} 缺少 README`, 'evidence-readme');
    if (gitOk(`cat-file -e ${sha}^{commit}`) === null)
      return fail(INDEX, line, `sha ${sha} 在仓库里不存在`, 'evidence-sha');
    if (globs.length === 0) return fail(INDEX, line, `${dir} 没有写覆盖路径`, 'evidence-globs');
    const changed = changedSince(sha);
    if (changed === null) return fail(INDEX, line, `无法计算 ${sha} 之后的改动`, 'evidence-git');
    const stale = globs.filter((g) => {
      const re = globToRegExp(g);
      return [...changed].some((f) => re.test(f));
    });
    if (stale.length > 0) {
      stats.stale++;
      return fail(
        INDEX,
        line,
        `${dir} 已过期：${stale.join('、')} 覆盖的文件在 ${sha} 之后改过`,
        'evidence-stale',
      );
    }
    stats.passed++;
  };

  for (const { cells: c, line } of tables.contract) {
    const [, , dir, globs, sha] = c.map(clean);
    if (!dir && !sha) {
      stats.unchecked++;
      continue;
    }
    if (!dir || !sha) {
      fail(INDEX, line, '证据与 sha 要么都写，要么都留空', 'evidence-pair');
      continue;
    }
    filed.add(unquote(dir));
    freshness(unquote(dir), splitGlobs(globs), sha, line);
  }

  for (const { cells: c, line } of tables.ui) {
    const [dir, , globs, sha] = c.map(clean);
    if (!dir || !sha) {
      fail(INDEX, line, '界面证据要同时写证据目录与 sha', 'evidence-pair');
      continue;
    }
    filed.add(unquote(dir));
    freshness(unquote(dir), splitGlobs(globs), sha, line);
  }

  for (const { cells: c, line } of tables.retired) {
    const [dir, reason] = c.map(clean);
    if (!dir) fail(INDEX, line, '退役条目缺证据目录', 'evidence-missing');
    if (!reason) fail(INDEX, line, `${dir} 退役但没有写原因`, 'evidence-reason');
    if (dir && !fs.existsSync(unquote(dir)))
      fail(INDEX, line, `退役条目指向的目录不存在：${unquote(dir)}`, 'evidence-missing');
    filed.add(unquote(dir));
  }

  // 新录的证据必须入表，不能静默留在目录里
  const onDisk = fs
    .readdirSync(EVIDENCE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(EVIDENCE_DIR, e.name));
  for (const dir of onDisk) {
    if (!filed.has(dir)) fail(EVIDENCE_DIR, 1, `${dir} 没有进证据索引`, 'evidence-unfiled');
  }

  return stats;
}

function splitGlobs(raw) {
  return raw
    .split(',')
    .map((g) => g.replace(/`/g, '').trim())
    .filter(Boolean);
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if ('\\^$.|?+()[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

function gitOk(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** sha 之后改过的文件：已提交的加工作区里未提交的。 */
function changedSince(sha) {
  const committed = gitOk(`diff --name-only ${sha}..HEAD`);
  if (committed === null) return null;
  const files = new Set(committed.split('\n').filter(Boolean));
  const status = gitOk('status --porcelain');
  if (status === null) return null;
  for (const line of status.split('\n').filter(Boolean)) {
    const rest = line.slice(3).trim();
    const target = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
    files.add(target.replace(/^"|"$/g, ''));
  }
  return files;
}
function notDoing() {
  const mvpLines = read(MVP);
  const start = mvpLines.findIndex((line) => line.startsWith('## 3. '));
  const end = mvpLines.findIndex((line, i) => i > start && /^## /.test(line));
  const mvpBody = start < 0 ? '' : mvpLines.slice(start, end < 0 ? undefined : end).join('\n');
  const mvpLine = mvpLines.find((line) => line.startsWith('多人协作与邀请'));
  const archLine = read(ARCH).find((line) => line.includes('明确不做：'));
  if (!mvpBody) fail(MVP, 1, '找不到第 3 节的「明确不做」正文', 'notdoing');
  if (!archLine) fail(ARCH, 1, '找不到「明确不做」清单', 'notdoing');
  if (!mvpBody || !archLine || !mvpLine) return;

  const strip = (s) => s.replace(/\s+/g, '');
  const body = strip(mvpBody);
  const archItems = archLine
    .slice(archLine.indexOf('明确不做：') + '明确不做：'.length)
    .replace(/。.*$/, '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);
  const mvpItems = mvpLine
    .replace(/。.*$/, '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const item of archItems) {
    if (!body.includes(strip(item)))
      fail(ARCH, 1, `architecture 第 2 节列了「${item}」，mvp 第 3 节里找不到`, 'notdoing');
  }
  for (const item of mvpItems) {
    if (!strip(archLine).includes(strip(item)))
      fail(MVP, 1, `mvp 第 3 节列了「${item}」，architecture 第 2 节没有`, 'notdoing');
  }
}

checkRoutes();
checkAcceptance();
notDoing();
const evidence = checkEvidence();

for (const p of problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  console.log(`${p.file}:${p.line}: ${p.message} [${p.rule}]`);
}
console.log(`证据：通过 ${evidence.passed} · 过期 ${evidence.stale} · 未检 ${evidence.unchecked}`);
console.log(problems.length === 0 ? 'docs check ok' : `${problems.length} 处不一致`);
process.exitCode = problems.length === 0 ? 0 : 1;
