import { tool } from 'ai';
import { z } from 'zod';
import { discoverSkills, loadSkill, readSkillFile } from './catalog';

/** 技能读取工具只返回文本；脚本执行仍属于项目命令的授权边界。 */
export function createSkillTools(options: Parameters<typeof discoverSkills>[0] = {}) {
  return {
    load_skill: tool({
      description: '按名称读取技能正文，技能中的相对引用以返回的 baseDir 为准。',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => loadSkill(await discoverSkills(options), name),
    }),
    read_skill_file: tool({
      description: '读取某个技能目录内的参考文件或脚本文本，不执行脚本。',
      inputSchema: z.object({ name: z.string().min(1), path: z.string().min(1) }),
      execute: async ({ name, path }) => readSkillFile(await discoverSkills(options), name, path),
    }),
  };
}
