import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 测试在哪里跑，是一个必须显式回答的问题。
 *
 * 现状是新增一个 test* 脚本不需要说明归属：E2E 装了 Chromium 却从未被执行，
 * 一个证明「迟到响应不能覆盖新保存」的用例被删掉后也没有任何人发现。
 * 这张表是唯一来源。新增脚本不填表就失败；填了和 CI 不一致也失败。
 */

type Placement = 'ci-push' | 'ci-manual' | 'local-only';

type SuiteRow = {
  readonly script: string;
  readonly runsIn: Placement;
  /** CI 实际调用的脚本名；省略时就是这个脚本本身。 */
  readonly via?: string;
  readonly why: string;
};

const suites: readonly SuiteRow[] = [
  { script: 'test', runsIn: 'ci-push', why: '单元测试，每次 push 和 PR' },
  { script: 'test:all', runsIn: 'ci-manual', why: 'vitest 三个 project；不含 Playwright' },
  {
    script: 'test:integration',
    runsIn: 'ci-manual',
    via: 'test:all',
    why: '需要 Postgres、Redis 和 _test 库，只在手动 full 的 job 里跑',
  },
  {
    script: 'test:system',
    runsIn: 'ci-manual',
    via: 'test:all',
    why: '需要 Docker 和 Chromium，只在手动 full 的 job 里跑',
  },
  {
    script: 'test:e2e',
    runsIn: 'local-only',
    why: '需要真实 app、harness 和 preview，CI 目前不启动这套栈',
  },
  {
    script: 'test:e2e:isolated',
    runsIn: 'local-only',
    why: '同上，外加隔离启动器与专属测试账号',
  },
  {
    script: 'test:e2e:dev',
    runsIn: 'local-only',
    why: '只在 dev 构建上断言控制台告警，必须人工跑',
  },
];

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const workflow = readFileSync(join(root, '..', '.github', 'workflows', 'tests.yml'), 'utf8');

const scripts = Object.keys(pkg.scripts ?? {}).filter((name) => /^test(:|$)/.test(name));
const problems: string[] = [];

for (const script of scripts) {
  const row = suites.find((entry) => entry.script === script);
  if (!row) {
    problems.push(
      `${script} 是新测试脚本，但没说它在哪里跑：在 scripts/verify/check-ci-coverage.ts 的表里补一行`,
    );
    continue;
  }
  const invoked = row.via ?? script;
  const inCi =
    workflow.includes(`npm run ${invoked}`) ||
    (invoked === 'test' && /\bnpm test\b/.test(workflow));
  if (row.runsIn === 'local-only' && inCi)
    problems.push(`${script} 标成 local-only，但 tests.yml 已经执行 ${invoked}：改表或删 CI 步骤`);
  if (row.runsIn !== 'local-only' && !inCi)
    problems.push(`${script} 标成 ${row.runsIn}，但 tests.yml 里没有执行 ${invoked}`);
}

for (const row of suites) {
  if (!scripts.includes(row.script))
    problems.push(`表里登记的 ${row.script} 已经不在 package.json 里：删掉这一行`);
}

if (problems.length > 0) {
  console.error('测试归属检查未通过：');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`测试归属检查通过（${suites.length} 个脚本，${scripts.length} 个在 package.json）`);
  for (const row of suites) console.log(`- ${row.script}: ${row.runsIn}，${row.why}`);
}
