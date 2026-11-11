import { describe, expect, it } from 'vitest';
import { parseSkillManifest } from './manifest';

describe('Skill 元信息解析', () => {
  it('解析 YAML 引号、多行描述与显式调用标记，正文独立返回', () => {
    const parsed = parseSkillManifest(`---
name: local-review
description: >-
  审查当前项目：
  检查文件与改动。
disable-model-invocation: true
---
# 审查步骤
读取 references/checklist.md。`);
    expect(parsed).toEqual({
      name: 'local-review',
      description: '审查当前项目： 检查文件与改动。',
      disableModelInvocation: true,
      body: '# 审查步骤\n读取 references/checklist.md。',
    });
    expect(
      parseSkillManifest('---\nname: test-skill\ndescription: "带冒号: 的描述"\n---\n正文')
        .description,
    ).toBe('带冒号: 的描述');
  });

  it('元信息没有名称时可使用技能目录名', () => {
    expect(parseSkillManifest('---\ndescription: 说明\n---\n正文', 'directory-name').name).toBe(
      'directory-name',
    );
  });

  it('正文里的名称与描述不能冒充 frontmatter', () => {
    expect(() => parseSkillManifest('# 示例\nname: fake\ndescription: fake')).toThrow(
      /frontmatter/,
    );
    expect(() =>
      parseSkillManifest('---\nname: test-skill\n---\ndescription: 正文中的说明'),
    ).toThrow(/description/);
  });

  it('拒绝重复键与非法类型，不把字符串 false 当作显式调用标记', () => {
    expect(() =>
      parseSkillManifest('---\nname: a\nname: b\ndescription: test\n---\n正文'),
    ).toThrow();
    expect(() =>
      parseSkillManifest('---\nname: test-skill\ndescription: [one, two]\n---\n正文'),
    ).toThrow(/description/);
    expect(() =>
      parseSkillManifest(
        '---\nname: test-skill\ndescription: test\ndisable-model-invocation: "false"\n---\n正文',
      ),
    ).toThrow(/disable-model-invocation/);
  });
});
