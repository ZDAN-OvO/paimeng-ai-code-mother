import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { LocalSkill, SkillCatalog } from '@/shared/api/schemas';
import { parseSkillManifest } from './manifest';

const MAX_FILE_BYTES = 1024 * 1024;

export class SkillReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function within(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function readText(file: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new SkillReadError(400, '技能路径不是文件');
  if (info.size > MAX_FILE_BYTES) throw new SkillReadError(413, '技能文件超过 1 MiB，不能加载');
  const text = await readFile(file, 'utf8');
  if (text.includes('\0')) throw new SkillReadError(400, '技能只支持文本文件');
  return text;
}

export async function discoverSkills(
  options: { projectPath?: string; userHome?: string } = {},
): Promise<SkillCatalog> {
  const directories = {
    user: path.resolve(options.userHome ?? homedir(), '.paimeng/skills'),
    project: options.projectPath ? path.resolve(options.projectPath, '.paimeng/skills') : null,
  };
  const catalog: SkillCatalog = { skills: [], directories, diagnostics: [] };
  const visited = new Set<string>();
  const names = new Map<string, LocalSkill>();
  async function scan(directory: string, source: LocalSkill['source']) {
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        catalog.diagnostics.push({ kind: 'io', path: directory, message: '无法读取技能目录' });
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    try {
      const entries = await readdir(canonical, { withFileTypes: true });
      if (entries.some((entry) => entry.name === 'SKILL.md')) {
        const filePath = path.join(canonical, 'SKILL.md');
        try {
          const actualFile = await realpath(filePath);
          if (!within(canonical, actualFile)) throw new Error('SKILL.md 链接越出技能目录');
          const metadata = parseSkillManifest(await readText(actualFile), path.basename(canonical));
          const existing = names.get(metadata.name);
          if (existing) {
            catalog.diagnostics.push({
              kind: 'collision',
              path: filePath,
              message: `技能 ${metadata.name} 同名，保留先发现的 ${existing.filePath}`,
            });
          } else {
            const skill: LocalSkill = {
              name: metadata.name,
              description: metadata.description,
              disableModelInvocation: metadata.disableModelInvocation,
              source,
              baseDir: canonical,
              filePath: actualFile,
            };
            names.set(skill.name, skill);
            catalog.skills.push(skill);
          }
        } catch (error) {
          catalog.diagnostics.push({
            kind: 'invalid',
            path: filePath,
            message: error instanceof Error ? error.message : '技能元信息无效',
          });
        }
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const child = path.join(canonical, entry.name);
        if (entry.isDirectory()) await scan(child, source);
        else if (entry.isSymbolicLink()) {
          try {
            if ((await stat(child)).isDirectory()) await scan(child, source);
          } catch {
            /* 断开的链接不参与发现。 */
          }
        }
      }
    } catch {
      catalog.diagnostics.push({ kind: 'io', path: directory, message: '无法枚举技能目录' });
    }
  }
  // 与 Pi 的默认发现顺序一致：用户级优先，随后项目级。
  await scan(directories.user, 'user');
  if (directories.project) await scan(directories.project, 'project');
  return catalog;
}

function find(catalog: SkillCatalog, name: string) {
  const skill = catalog.skills.find((item) => item.name === name);
  if (!skill) throw new SkillReadError(404, `找不到技能 ${name}`);
  return skill;
}

export async function readSkillFile(catalog: SkillCatalog, name: string, relativePath: string) {
  const skill = find(catalog, name);
  const target = path.resolve(skill.baseDir, relativePath);
  if (path.isAbsolute(relativePath) || !within(skill.baseDir, target))
    throw new SkillReadError(403, '只能读取技能目录内的文件');
  let actual: string;
  try {
    actual = await realpath(target);
  } catch {
    throw new SkillReadError(404, '技能文件不存在');
  }
  if (!within(skill.baseDir, actual)) throw new SkillReadError(403, '文件链接不能越出技能目录');
  return readText(actual);
}

export async function loadSkill(catalog: SkillCatalog, name: string) {
  const skill = find(catalog, name);
  const metadata = parseSkillManifest(
    await readSkillFile(catalog, name, 'SKILL.md'),
    path.basename(skill.baseDir),
  );
  return { ...skill, ...metadata };
}

export function formatSkillsForPrompt(skills: LocalSkill[]) {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return [
    '<available_skills>',
    ...visible.map(
      (skill) =>
        `  <skill><name>${escape(skill.name)}</name><description>${escape(skill.description)}</description><location>${escape(skill.filePath)}</location></skill>`,
    ),
    '</available_skills>',
  ].join('\n');
}
