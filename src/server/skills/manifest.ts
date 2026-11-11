import { parseDocument } from 'yaml';
import { z } from 'zod';

const metadataSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  'disable-model-invocation': z.boolean().optional(),
});

/** 只解释 YAML 元信息；正文与引用的读取、脚本执行各自走独立入口。 */
export function parseSkillManifest(content: string, directoryName?: string) {
  const match = content.match(/^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md 必须以 YAML frontmatter 开始');
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0)
    throw new Error(`技能 YAML 不合法：${document.errors[0].message}`);
  const raw: unknown = document.toJS({ maxAliasCount: 20 });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('技能 frontmatter 必须是字段映射');
  }
  const result = metadataSchema.safeParse({
    ...raw,
    name: 'name' in raw ? raw.name : directoryName,
  });
  if (!result.success) {
    throw new Error(
      `技能元信息不合法：${result.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
    );
  }
  return {
    name: result.data.name,
    description: result.data.description,
    disableModelInvocation: result.data['disable-model-invocation'] ?? false,
    body: content.slice(match[0].length).trim(),
  };
}
