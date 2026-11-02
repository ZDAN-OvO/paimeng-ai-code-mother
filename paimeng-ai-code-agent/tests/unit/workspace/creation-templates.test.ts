import { describe, expect, it } from 'vitest';
import { creationTemplates, templateForStarter } from '@/shared/templates';
import { defaultTemplateFor, readTemplateFile, resolveTemplate, templateEntry, templateFiles, templateLockfile, templatePackageManager } from '@/server/templates/templates';
import { validateTemplateManifest } from '@/server/templates/templates';
import { assertRegistryDependencies } from '@/server/delivery/dependency-policy';

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

  it('模板说明让模型复用组件与令牌，并说明可以用 shell 装 registry 依赖', async () => {
    const template = resolveTemplate('react-ts', '2.0.0');
    const agents = await readTemplateFile(template, 'AGENTS.md');
    expect(agents).toContain('src/components/ui/');
    expect(agents).toContain('src/index.css');
    expect(agents).toContain('pnpm');
    expect(agents).toContain('shell');
    expect(agents).toContain('npm registry');
    expect(agents).not.toContain('依赖与 pnpm-lock.yaml 由模板版本固定');
  });

  it('React 厚架子不再逐字节锁定依赖：模板清单与锁文件只校验来源', async () => {
    const template = resolveTemplate('react-ts', '2.0.0');
    const manifest = await readTemplateFile(template, 'package.json');
    expect(() => assertRegistryDependencies({ manifest, lockfile: null })).not.toThrow();
    const parsed = JSON.parse(manifest) as { dependencies: Record<string, string> };
    parsed.dependencies.dayjs = '^1.11.0';
    expect(() => assertRegistryDependencies({ manifest: JSON.stringify(parsed), lockfile: null })).not.toThrow();
    // pnpm 模板不再走「按模板版本锁定」的旧校验，这条路径由依赖来源策略取代。
    await expect(validateTemplateManifest(template, manifest)).rejects.toThrow('pnpm 模板不按模板版本锁定依赖');
    parsed.dependencies.dayjs = 'git+https://github.com/user/repo.git';
    expect(() => assertRegistryDependencies({ manifest: JSON.stringify(parsed), lockfile: null })).toThrow('依赖来源不被允许');
  });
});
