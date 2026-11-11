import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, formatSkillsForPrompt, loadSkill, readSkillFile } from './catalog';
import { createSkillTools } from './tools';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paimeng-skills-'));
  roots.push(root);
  return { root, userHome: path.join(root, 'home'), projectPath: path.join(root, 'project') };
}
async function skill(root: string, name: string, body = '# 步骤', extra = '') {
  const base = path.join(root, '.paimeng/skills', name);
  await mkdir(base, { recursive: true });
  await writeFile(
    path.join(base, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}的说明\n${extra}---\n${body}`,
  );
  return base;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('项目级与用户级技能', () => {
  it('从两处目录递归发现，仅索引元信息，正文与参考文件按需读取', async () => {
    const f = await fixture();
    const base = await skill(f.userHome, 'user-style', '# 用户正文');
    await mkdir(path.join(base, 'references'));
    await writeFile(path.join(base, 'references/tone.md'), '参考内容');
    await skill(f.projectPath, 'project-check', '# 项目正文');
    const catalog = await discoverSkills(f);
    expect(catalog.skills.map((item) => [item.name, item.source])).toEqual([
      ['user-style', 'user'],
      ['project-check', 'project'],
    ]);
    expect(JSON.stringify(catalog)).not.toContain('# 用户正文');
    expect(formatSkillsForPrompt(catalog.skills)).toContain('user-style');
    expect(formatSkillsForPrompt(catalog.skills)).not.toContain('用户正文');
    expect((await loadSkill(catalog, 'user-style')).body).toBe('# 用户正文');
    expect(await readSkillFile(catalog, 'user-style', 'references/tone.md')).toBe('参考内容');
    const tools = createSkillTools(f);
    const execution = { toolCallId: 'test-call', messages: [], context: {} };
    expect(await tools.load_skill.execute!({ name: 'user-style' }, execution)).toMatchObject({
      body: '# 用户正文',
    });
    expect(
      await tools.read_skill_file.execute!(
        { name: 'user-style', path: 'references/tone.md' },
        execution,
      ),
    ).toBe('参考内容');
  });

  it('按 Pi 顺序先用户级后项目级，同名保留先发现项并给出冲突提示', async () => {
    const f = await fixture();
    await skill(f.userHome, 'same-name', '用户内容');
    await skill(f.projectPath, 'same-name', '项目内容');
    const catalog = await discoverSkills(f);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0].source).toBe('user');
    expect(catalog.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'collision' })]),
    );
    expect((await loadSkill(catalog, 'same-name')).body).toBe('用户内容');
  });

  it('显式调用技能不进入自动选择提示，但仍能手动读取；发现与读取均不执行脚本', async () => {
    const f = await fixture();
    const base = await skill(
      f.userHome,
      'explicit-only',
      '手动正文',
      'disable-model-invocation: true\n',
    );
    await mkdir(path.join(base, 'scripts'));
    await writeFile(path.join(base, 'scripts/example.js'), 'throw new Error("不应该执行");');
    const catalog = await discoverSkills(f);
    expect(formatSkillsForPrompt(catalog.skills)).toBe('');
    expect((await loadSkill(catalog, 'explicit-only')).body).toBe('手动正文');
    expect(await readSkillFile(catalog, 'explicit-only', 'scripts/example.js')).toContain(
      '不应该执行',
    );
  });

  it('空目录正常返回，坏技能提示但不阻止其他技能', async () => {
    const f = await fixture();
    expect((await discoverSkills(f)).skills).toEqual([]);
    await skill(f.userHome, 'good-skill');
    const bad = path.join(f.userHome, '.paimeng/skills/bad');
    await mkdir(bad);
    await writeFile(path.join(bad, 'SKILL.md'), '# 没有元信息');
    const catalog = await discoverSkills(f);
    expect(catalog.skills.map((item) => item.name)).toEqual(['good-skill']);
    expect(catalog.diagnostics).toHaveLength(1);
  });

  it('引用文件不能使用目录穿越或符号链接读取技能目录外内容', async () => {
    const f = await fixture();
    const base = await skill(f.userHome, 'safe-skill');
    const outside = path.join(f.root, 'outside.txt');
    await writeFile(outside, '外部内容');
    await symlink(outside, path.join(base, 'outside-link'));
    const catalog = await discoverSkills(f);
    await expect(readSkillFile(catalog, 'safe-skill', '../outside.txt')).rejects.toThrow(
      /技能目录/,
    );
    await expect(readSkillFile(catalog, 'safe-skill', 'outside-link')).rejects.toThrow(/技能目录/);
  });

  it('跟随技能目录链接时去重并终止循环', async () => {
    const f = await fixture();
    const base = await skill(f.userHome, 'linked-skill');
    const root = path.dirname(base);
    await symlink(root, path.join(root, 'cycle'), 'dir');
    await symlink(base, path.join(root, 'duplicate'), 'dir');
    const catalog = await discoverSkills(f);
    expect(catalog.skills).toHaveLength(1);
  });
});
