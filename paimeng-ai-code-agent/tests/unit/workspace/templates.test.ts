import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeTemplate, appTemplate } from '@/server/workspace/template-workspace';
import { resolveTemplate, readTemplateFile, TEMPLATE_MARKER } from '@/server/templates/templates';
import { workspace, listProjectFiles, readProjectFile, writeProjectFile } from '@/server/workspace/workspace';
import { downloadApp, buildApp } from '@/server/delivery/artifacts';
import { classifyBuildFailure } from '@/server/delivery/build-feedback';
import type { ProjectCodeGenType } from '@/shared/contracts';

const cases: { id: string; version: string; type: ProjectCodeGenType; entry: string; jsEntry: string; source: string; sample: string; removable: string; lockfile: string }[] = [
  { id: 'vue-ts', version: '1.0.0', type: 'vue_project', entry: 'src/main.ts', jsEntry: 'src/main.js', source: 'src/App.vue', sample: 'src/composables/useTasks.ts', removable: 'pinia', lockfile: 'package-lock.json' },
  { id: 'react-ts', version: '1.0.0', type: 'react_project', entry: 'src/main.tsx', jsEntry: 'src/main.jsx', source: 'src/App.tsx', sample: 'src/hooks/useTasks.ts', removable: 'antd', lockfile: 'package-lock.json' },
  { id: 'react-ts', version: '2.0.0', type: 'react_project', entry: 'src/main.tsx', jsEntry: 'src/main.jsx', source: 'src/pages/home.tsx', sample: 'src/components/ui/button.tsx', removable: 'lucide-react', lockfile: 'pnpm-lock.yaml' },
];
const base = Date.now() + 7000;
const apps = cases.flatMap((item, index) => [0, 1, 2].map(offset => ({ id: String(base + index * 3 + offset), codeGenType: item.type })));
afterAll(async () => { for (const app of apps) await rm(workspace(app), { recursive: true, force: true }); });

describe.each(cases)('版本化 $id@$version 工程模板', item => {
 const template = resolveTemplate(item.id, item.version);
 const fresh = apps[cases.indexOf(item) * 3];
 const legacy = apps[cases.indexOf(item) * 3 + 1];
 const damaged = apps[cases.indexOf(item) * 3 + 2];

  it('初始化完整工程并记录版本，重复初始化保留已有修改', async () => {
    expect(await initializeTemplate(fresh, template)).toBe(true);
    expect(await appTemplate(fresh)).toMatchObject({ id: item.id, version: item.version, runtime: 'static' });
    expect(await listProjectFiles(fresh)).toEqual(expect.arrayContaining([item.entry, item.source, item.sample, item.lockfile, 'AGENTS.md']));
    expect(await listProjectFiles(fresh)).not.toContain(TEMPLATE_MARKER);
    await writeProjectFile(fresh, 'src/user-note.ts', 'export const note = "用户的修改";');
    expect(await initializeTemplate(fresh, template)).toBe(false);
    expect(await readProjectFile(fresh, 'src/user-note.ts')).toContain('用户的修改');
  });

  it('旧工程没有模板身份，不能被模板覆盖', async () => {
    await writeProjectFile(legacy, 'src/legacy.txt', '旧工程保留');
    expect(await appTemplate(legacy)).toBeNull();
    await expect(initializeTemplate(legacy, template)).rejects.toThrow('已有工程不能用模板覆盖');
    expect(await readProjectFile(legacy, 'src/legacy.txt')).toContain('旧工程保留');
    expect(() => resolveTemplate(item.id, '9.0.0')).toThrow('不支持的工程模板');
    await expect(initializeTemplate({ id: fresh.id, codeGenType: 'html' }, template)).rejects.toThrow('模板与应用类型不匹配');
  });

  it('工具只保护模板身份，写入内容交给构建校验', async () => {
    await initializeTemplate(fresh, template);
    await expect(readProjectFile(fresh, TEMPLATE_MARKER)).rejects.toThrow('文件路径不允许访问');
    await expect(writeProjectFile(fresh, TEMPLATE_MARKER, '{}')).rejects.toThrow('文件路径不允许访问');
    await expect(writeProjectFile(fresh, item.lockfile, '')).resolves.toBeUndefined();
    const stages: string[] = [];
    const lockError = await buildApp(fresh, undefined, (stage, status) => { stages.push(`${stage}:${status}`); }).catch((error: unknown) => error);
    expect(lockError).toBeInstanceOf(Error);
    expect((lockError as Error).message).toContain('模板依赖锁已改变');
    expect(classifyBuildFailure(lockError)).toMatchObject({ repairable: true, stage: 'source' });
    expect(stages).toEqual(['source:started', 'source:failed']);
    await expect(writeProjectFile(fresh, item.lockfile, await readTemplateFile(template, item.lockfile))).resolves.toBeUndefined();
    const manifest = JSON.parse(await readProjectFile(fresh, 'package.json'));
    delete manifest.dependencies[item.removable];
    await expect(writeProjectFile(fresh, 'package.json', JSON.stringify(manifest))).resolves.toBeUndefined();
    await expect(buildApp(fresh)).rejects.toThrow(item.lockfile === 'pnpm-lock.yaml' ? '依赖由模板版本固定' : '保留全部依赖');
    await expect(writeProjectFile(fresh, item.jsEntry, 'export default {}')).resolves.toBeUndefined();
    await expect(writeProjectFile(fresh, 'vite.config.js', 'export default {}')).resolves.toBeUndefined();
    await expect(writeProjectFile(fresh, 'vite.config.ts', await readTemplateFile(template, 'vite.config.ts'))).resolves.toBeUndefined();
  });

  it('损坏或软链接的模板身份会报错，不悄悄退回旧构建', async () => {
    await initializeTemplate(fresh, template);
    await initializeTemplate(damaged, template);
    const marker = join(workspace(damaged), TEMPLATE_MARKER);
    await writeFile(marker, JSON.stringify({ id: item.id, version: '9.0.0' }));
    await expect(appTemplate(damaged)).rejects.toThrow('不支持的工程模板');
    await rm(marker);
    await symlink(join(workspace(fresh), TEMPLATE_MARKER), marker);
    await expect(appTemplate(damaged)).rejects.toThrow();
  });

  it('下载的是可独立运行的模板工程，包含锁文件和说明，不包含内部身份', async () => {
    await initializeTemplate(fresh, template);
    const response = await downloadApp(fresh);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    for (const file of [item.lockfile, 'AGENTS.md', 'README.md', item.entry]) expect(bytes.toString()).toContain(file);
    expect(bytes.toString()).not.toContain(TEMPLATE_MARKER);
  });


});
