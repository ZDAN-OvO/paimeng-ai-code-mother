/**
 * 测评集的数据形状。validate.ts 与 run-case.ts 共用，避免两处 schema 漂移。
 * 字段含义与用法见 ../README.md；这里的 strict() 会拒绝拼错的字段名。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const suites = ['smoke', 'functional', 'constraints', 'adversarial', 'multiturn', 'web'] as const;
export const codeGenTypes = ['html', 'multi_file', 'vue_project', 'react_project', 'auto'] as const;
export const evidenceKinds = ['dom', 'visual', 'source', 'transcript', 'network', 'runtime'] as const;

export const templateFor: Record<(typeof codeGenTypes)[number], string | null> = {
  html: 'html',
  multi_file: 'multi-file',
  vue_project: 'vue-ts',
  react_project: 'react-ts',
  auto: null,
};

export const requirementSchema = z.object({
  id: z.string().regex(/^R\d+$/, '要求 id 必须是 R1、R2 这种形式'),
  evidence: z.enum(evidenceKinds),
  action: z.string().min(2),
  expect: z.string().min(2),
  partial: z.string().min(2).optional(),
}).strict();

export const followUpSchema = z.object({
  kind: z.enum(['follow-up', 'answer', 'steer']),
  text: z.string().min(1).max(1000),
  after: z.string().min(2).optional(),
}).strict();

export const caseSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{2}-[a-z0-9-]+$/, '用例 id 形如 func-01-form-signup'),
  title: z.string().min(2),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  codeGenType: z.enum(codeGenTypes),
  templateId: z.string().min(1).nullable(),
  execution: z.enum(['runner', 'manual']).default('runner'),
  tags: z.array(z.string().min(1)).min(1).max(8),
  prompt: z.string().min(10).max(1000),
  followUps: z.array(followUpSchema).max(4).default([]),
  requirements: z.array(requirementSchema).min(2).max(8),
  signals: z.object({
    ask: z.enum(['forbidden', 'allowed', 'required']),
    web: z.enum(['forbidden', 'allowed', 'required']),
    earlyPreview: z.boolean().default(true),
    citations: z.boolean().default(false),
    maxMinutes: z.number().positive().max(30).default(12),
  }).strict(),
  notes: z.string().min(2),
}).strict();

export const suiteSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.enum(suites),
  title: z.string().min(2),
  description: z.string().min(2),
  cases: z.array(caseSchema).min(1),
}).strict();

export type EvalCase = z.infer<typeof caseSchema>;
export type EvalSuite = z.infer<typeof suiteSchema>;
export type Requirement = z.infer<typeof requirementSchema>;

export async function loadCases(datasetDir: string): Promise<{ file: string; suite: EvalSuite; cases: EvalCase[] }[]> {
  const files = (await readdir(datasetDir)).filter(name => name.endsWith('.json')).sort();
  const result: { file: string; suite: EvalSuite; cases: EvalCase[] }[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(datasetDir, file), 'utf8'));
    const parsed = suiteSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}：${issue.message}`).join('；');
      throw new Error(`${file} 不符合 schema：${detail}`);
    }
    result.push({ file, suite: parsed.data, cases: parsed.data.cases });
  }
  return result;
}
