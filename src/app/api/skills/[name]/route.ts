import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { skillDetailSchema, type SkillFile } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { discoverSkills, readSkillFile } from '@/server/skills/catalog';
import { projectRoot } from '@/server/projects';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ name: string }> };

async function filesFor(baseDir: string, current = '', depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const entries = await readdir(path.join(baseDir, current), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesFor(baseDir, relative, depth + 1)));
    else if (entry.isFile()) files.push(relative);
    if (files.length >= 100) break;
  }
  return files;
}

export const GET = withErrors(async (request: Request, { params }: Params) => {
  const { name } = await params;
  const projectId = new URL(request.url).searchParams.get('projectId');
  const catalog = await discoverSkills({
    projectPath: projectId ? await projectRoot(projectId) : undefined,
  });
  const skill = catalog.skills.find((item) => item.name === name);
  if (!skill) return json({ error: '技能不存在' }, 404);
  const files: SkillFile[] = [];
  for (const relative of await filesFor(skill.baseDir)) {
    try {
      files.push({ path: relative, content: await readSkillFile(catalog, name, relative) });
    } catch {
      /* 只展示可读文本文件。 */
    }
  }
  return json(skillDetailSchema.parse({ skill, files }));
});
