/**
 * 测评集校验：schema、ID 唯一性、类型与模板映射、跨字段一致性。
 *
 * 用法（在 paimeng-ai-code-agent/ 下）：
 *   npx tsx evals/scripts/validate.ts
 *   npx tsx evals/scripts/validate.ts --suite functional
 *
 * 只读文件，不联网、不连数据库。退出码 1 表示有错误。
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadCases, suites, templateFor, type EvalCase } from './schema';

const evalRoot = fileURLToPath(new URL('..', import.meta.url));
const datasetDir = join(evalRoot, 'datasets');

const errors: string[] = [];
const seen = new Map<string, string>();
let caseCount = 0;
let manualCount = 0;

function fail(file: string, message: string) {
  errors.push(`${file}: ${message}`);
}

function checkCase(file: string, suite: string, value: EvalCase) {
  const at = `${file} [${value.id}]`;
  caseCount += 1;
  if (seen.has(value.id)) fail(file, `用例 id 重复：${value.id}（已出现在 ${seen.get(value.id)}）`);
  seen.set(value.id, file);
  if (value.execution === 'manual') manualCount += 1;

  if (templateFor[value.codeGenType] !== value.templateId) {
    fail(
      at,
      `codeGenType=${value.codeGenType} 必须配 templateId=${String(templateFor[value.codeGenType])}，实际是 ${String(value.templateId)}`,
    );
  }
  if (value.execution === 'manual' && suite !== 'multiturn') {
    fail(at, 'manual 只用于 multi-turn（steer / 版本恢复），其他套件必须可自动跑');
  }
  if (
    value.execution === 'manual' &&
    !value.followUps.some((item) => item.kind === 'steer') &&
    !/手工|手动/.test(value.notes)
  ) {
    fail(at, 'manual 用例必须在 notes 里写清手工步骤，或包含 steer');
  }
  for (const [index, item] of value.followUps.entries()) {
    if (item.kind === 'steer' && value.execution !== 'manual') {
      fail(at, `followUps[${index}] 是 steer，用例必须标 manual（runner 不做定时插话）`);
    }
    if (item.kind === 'answer' && value.signals.ask !== 'required') {
      fail(at, `followUps[${index}] 是 answer，但 signals.ask 不是 required`);
    }
  }
  if (
    value.signals.ask === 'required' &&
    value.followUps.filter((item) => item.kind === 'answer').length !== 1
  ) {
    fail(at, 'ask=required 的用例必须正好有一个 answer follow-up，否则 runner 会停在等待回答');
  }
  if (value.signals.citations && value.signals.web !== 'required')
    fail(at, 'citations=true 要求 signals.web=required');
  if (suite === 'web' && value.signals.web === 'forbidden')
    fail(at, 'web 套件里的用例不能 web=forbidden');

  const ids = value.requirements.map((item) => item.id);
  const expected = value.requirements.map((_, index) => `R${index + 1}`);
  if (ids.join(',') !== expected.join(',')) {
    fail(at, `要求 id 必须按顺序连续：期望 ${expected.join(',')}，实际 ${ids.join(',')}`);
  }
  const unique = new Set<string>();
  for (const requirement of value.requirements) {
    const key = `${requirement.action}::${requirement.expect}`;
    if (unique.has(key)) fail(at, `重复的要求：${requirement.id}`);
    unique.add(key);
    if (requirement.partial && !/缺|部分|不稳定|只/.test(requirement.partial)) {
      fail(at, `${requirement.id} 的 partial 要说明「差在哪」，不能只写一句同义重复`);
    }
  }
}

const requested = process.argv.includes('--suite')
  ? process.argv[process.argv.indexOf('--suite') + 1]
  : undefined;
if (requested && !(suites as readonly string[]).includes(requested)) {
  console.error(`未知套件 ${requested}，可选：${suites.join(', ')}`);
  process.exit(2);
}

let loaded: Awaited<ReturnType<typeof loadCases>>;
try {
  loaded = await loadCases(datasetDir);
} catch (error) {
  console.error(`测评集加载失败：${(error as Error).message}`);
  process.exit(1);
}

for (const { file, suite } of loaded) {
  if (`${suite.suite}.json` !== file) fail(file, `文件名必须与 suite 一致：${suite.suite}.json`);
  if (requested && suite.suite !== requested) continue;
  for (const value of suite.cases) checkCase(file, suite.suite, value);
}

if (errors.length > 0) {
  console.error(`\n测评集校验失败（${errors.length} 个问题）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('测评集校验通过');
console.log(
  `  套件 ${loaded.length} 个，用例 ${caseCount} 条，其中需要手工执行的 ${manualCount} 条`,
);
for (const { suite, cases } of loaded) {
  const manual = cases.filter((item) => item.execution === 'manual').length;
  console.log(
    `  - ${suite.suite.padEnd(12)} ${String(cases.length).padStart(2)} 条${manual ? `（手工 ${manual}）` : ''}`,
  );
}
