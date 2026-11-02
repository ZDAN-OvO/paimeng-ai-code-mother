import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cp } from 'node:fs/promises';
import { finalizeRuntimeDependencies } from '@/server/app-runtime/dependencies';

/** 轮末归一化的失败边界：运行时不可用时不能把「没检查」当成成功；来源违规在跑 pnpm 前就拒绝。 */

const app = { id: '140000001', codeGenType: 'react_project' as const };
const templateRoot = join(process.cwd(), 'templates', 'react-ts', '2.0.0');
const temporaryDirectories: string[] = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dependency-finalize-'));
  temporaryDirectories.push(root);
  await cp(templateRoot, root, { recursive: true });
  await writeFile(join(root, '.paimeng-template.json'), JSON.stringify({ id: 'react-ts', version: '2.0.0' }));
  return root;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('轮末依赖归一化的失败边界', () => {
  it('App runtime 未就绪时明确失败，不生成/保留不一致的锁文件，也不调用 pnpm', async () => {
    const root = await workspace();
    const before = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    let ran = false;
    await expect(finalizeRuntimeDependencies({
      app,
      workspaceRoot: root,
      runtime: async () => { ran = true; return { status: 'failed', error: 'docker 不可用' }; },
    })).rejects.toThrow(/依赖归一化失败：App runtime 未就绪（failed：docker 不可用）/);
    expect(ran).toBe(true);
    expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(before);
  });

  it('工程里有 .npmrc 时在运行 pnpm 前就拒绝', async () => {
    const root = await workspace();
    await writeFile(join(root, '.npmrc'), 'registry=https://evil.invalid/');
    let askedRuntime = false;
    await expect(finalizeRuntimeDependencies({
      app,
      workspaceRoot: root,
      runtime: async () => { askedRuntime = true; return { status: 'ready', error: null }; },
    })).rejects.toThrow(/不允许 \.npmrc/);
    expect(askedRuntime).toBe(false);
  });

  it('git: 依赖在运行 pnpm 前就拒绝', async () => {
    const root = await workspace();
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    manifest.dependencies.vite = 'git+https://github.com/user/repo.git';
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    let askedRuntime = false;
    await expect(finalizeRuntimeDependencies({
      app,
      workspaceRoot: root,
      runtime: async () => { askedRuntime = true; return { status: 'ready', error: null }; },
    })).rejects.toThrow(/依赖来源不被允许/);
    expect(askedRuntime).toBe(false);
  });

  it('runtime 被显式关闭时不做归一化（模型也没有 shell），直接跳过', async () => {
    const root = await workspace();
    const previous = process.env.APP_RUNTIME_ENABLED;
    process.env.APP_RUNTIME_ENABLED = 'false';
    try {
      let askedRuntime = false;
      await finalizeRuntimeDependencies({
        app,
        workspaceRoot: root,
        runtime: async () => { askedRuntime = true; return { status: 'ready', error: null }; },
      });
      expect(askedRuntime).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.APP_RUNTIME_ENABLED;
      else process.env.APP_RUNTIME_ENABLED = previous;
    }
  });
});
