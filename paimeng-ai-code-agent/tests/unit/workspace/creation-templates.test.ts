import { describe, expect, it } from 'vitest';
import { creationTemplates, templateForStarter } from '@/shared/templates';
import { defaultTemplateFor, readTemplateFile, resolveTemplate, templateEntry, templateFiles, templateLockfile, templatePackageManager } from '@/server/templates/templates';
import { validateTemplateManifest } from '@/server/templates/templates';

const identity = (template: { id: string; version: string }) => `${template.id}@${template.version}`;

describe('新建应用的起点', () => {
  it('界面只提供轻量静态页与 React 厚架子两种模板', () => {
    expect(creationTemplates.map(item => ({ starter: item.starter, template: identity(item.template), label: item.label }))).toEqual([
      { starter: 'light', template: 'html@1.0.0', label: '轻量静态页' },
      { starter: 'build', template: 'react-ts@2.0.0', label: 'React 厚架子' },
    ]);
    expect(templateForStarter('light')).toMatchObject({ id: 'html', version: '1.0.0', codeGenType: 'html' });
    expect(templateForStarter('build')).toMatchObject({ id: 'react-ts', version: '2.0.0', codeGenType: 'react_project' });
  });

  it('旧模板仍可解析，构建类 App 的默认模板是 2.0.0', () => {
    expect(defaultTemplateFor('react_project')).toMatchObject({ id: 'react-ts', version: '2.0.0' });
    expect(resolveTemplate('react-ts')).toMatchObject({ version: '2.0.0' });
    expect(resolveTemplate('react-ts', '1.0.0')).toMatchObject({ version: '1.0.0' });
    expect(resolveTemplate('vue-ts')).toMatchObject({ id: 'vue-ts', version: '1.0.0' });
    expect(resolveTemplate('multi-file')).toMatchObject({ id: 'multi-file', version: '1.0.0' });
  });

  it('React 厚架子包含布局、令牌、shadcn 组件源码、路由与带数据的示例页面', async () => {
    const template = resolveTemplate('react-ts', '2.0.0');
    expect(templateEntry(template)).toBe('src/main.tsx');
    expect(templatePackageManager(template)).toBe('pnpm');
    expect(templateLockfile(template)).toBe('pnpm-lock.yaml');
    expect(templateFiles(template)).toEqual(expect.arrayContaining([
      'pnpm-lock.yaml',
      'src/index.css',
      'src/lib/utils.ts',
      'src/components/ui/button.tsx',
      'src/components/ui/card.tsx',
      'src/components/layout/app-shell.tsx',
      'src/pages/home.tsx',
      'src/pages/about.tsx',
      'src/data/dashboard.ts',
    ]));
    const manifest = JSON.parse(await readTemplateFile(template, 'package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; packageManager: string };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(dependencies).not.toHaveProperty('antd');
    expect(manifest.packageManager).toMatch(/^pnpm@/);
    for (const name of ['tailwindcss', '@tailwindcss/vite', 'lucide-react', 'react-router', 'react', 'react-dom', 'vite', 'typescript']) expect(dependencies).toHaveProperty(name);
    for (const [name, version] of Object.entries(dependencies)) expect(version, `${name} 必须是精确版本`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await readTemplateFile(template, 'pnpm-lock.yaml')).toContain('lockfileVersion');
  });

  it('模板说明让模型复用组件与令牌，且不宣称 shell 能力', async () => {
    const template = resolveTemplate('react-ts', '2.0.0');
    const agents = await readTemplateFile(template, 'AGENTS.md');
    expect(agents).toContain('src/components/ui/');
    expect(agents).toContain('src/index.css');
    expect(agents).toContain('pnpm');
    expect(agents).not.toMatch(/用 shell|shell 工具|通过 shell|使用 shell/i);
  });

  it('依赖以模板版本为准：改动 package.json 会被拒绝，锁文件单独校验', async () => {
    const template = resolveTemplate('react-ts', '2.0.0');
    const manifest = await readTemplateFile(template, 'package.json');
    const parsed = JSON.parse(manifest) as { dependencies: Record<string, string> };
    await expect(validateTemplateManifest(template, manifest)).resolves.toEqual(expect.objectContaining({ react: expect.any(String) }));
    parsed.dependencies.react = '19.0.0';
    await expect(validateTemplateManifest(template, JSON.stringify(parsed))).rejects.toThrow('依赖由模板版本固定');

    // 同名依赖塞进 dependencies 不能被 devDependencies 的锁定盖掉。
    const shadowed = JSON.parse(manifest) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    shadowed.dependencies.vite = 'https://evil.invalid/package.tgz';
    await expect(validateTemplateManifest(template, JSON.stringify(shadowed))).rejects.toThrow('依赖由模板版本固定');
  });
});
