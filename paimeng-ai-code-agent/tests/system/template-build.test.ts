import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate, readTemplateFile, templateLockfile } from '@/server/templates/templates';
import { workspace, writeProjectFile, readProjectFile } from '@/server/workspace/workspace';
import { buildApp, hasPreview } from '@/server/delivery/artifacts';
const cases = [
  { id: 'vue-ts', version: '1.0.0', type: 'vue_project' as const },
  { id: 'react-ts', version: '1.0.0', type: 'react_project' as const },
  { id: 'react-ts', version: '2.0.0', type: 'react_project' as const },
];
const base = Date.now() + 10000;
const apps = cases.map((item, index) => ({ id: String(base + index), codeGenType: item.type }));
afterAll(async () => { for (const app of apps) await rm(workspace(app), { recursive: true, force: true }); });
describe.each(cases)('真实 $id@$version 模板构建', item => {
  const template = resolveTemplate(item.id, item.version);
  const app = apps[cases.indexOf(item)];
  it('未经 AI 修改的示例通过真实安装、类型检查与构建，改锁、非法依赖或类型错误都不覆盖旧产物', async () => {
    await initializeTemplate(app, template);
    await buildApp(app);
    expect(await hasPreview(app)).toBe(true);
    const before = await readFile(join(workspace(app), 'dist/index.html'), 'utf8');
    expect(before).toContain('./assets/');

    const lockfile = templateLockfile(template);
    const pnpm = lockfile === 'pnpm-lock.yaml';
    await writeFile(join(workspace(app), lockfile), pnpm ? 'lockfileVersion: 0\n' : '{}');
    await expect(buildApp(app)).rejects.toThrow(pnpm ? '锁文件无法识别' : '模板依赖锁已改变');
    expect(await readFile(join(workspace(app), 'dist/index.html'), 'utf8')).toBe(before);

    await writeFile(join(workspace(app), lockfile), await readTemplateFile(template, lockfile));
    const manifest = JSON.parse(await readProjectFile(app, 'package.json'));
    manifest.dependencies.vite = 'https://evil.invalid/package.tgz';
    await expect(writeProjectFile(app, 'package.json', JSON.stringify(manifest))).resolves.toBeUndefined();
    await expect(buildApp(app)).rejects.toThrow(pnpm ? '依赖来源不被允许' : '不允许的构建依赖');
    expect(await readFile(join(workspace(app), 'dist/index.html'), 'utf8')).toBe(before);

    if (pnpm) {
      // registry 依赖可以由模型自己安装；这里验证清单更新而锁文件没跟上时构建明确失败，不产出新 dist。
      delete manifest.dependencies.vite;
      manifest.dependencies.dayjs = '^1.11.0';
      await expect(writeProjectFile(app, 'package.json', JSON.stringify(manifest))).resolves.toBeUndefined();
      await expect(buildApp(app)).rejects.toThrow(/OUTDATED_LOCKFILE|依赖安装失败|构建失败/);
      expect(await readFile(join(workspace(app), 'dist/index.html'), 'utf8')).toBe(before);
      await writeFile(join(workspace(app), lockfile), await readTemplateFile(template, lockfile));
    }
    await writeProjectFile(app, 'package.json', await readTemplateFile(template, 'package.json'));
    await expect(buildApp(app)).resolves.toBeUndefined();

    await writeProjectFile(app, 'src/type-error.ts', 'export const count: number = "这不是数字";');
    await expect(buildApp(app)).rejects.toThrow('not assignable to type');
    expect(await readFile(join(workspace(app), 'dist/index.html'), 'utf8')).toBe(before);
  }, 360000);
});
