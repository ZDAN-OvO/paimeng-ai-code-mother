import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'paimeng-workspace-'));
const outside = mkdtempSync(path.join(os.tmpdir(), 'paimeng-outside-'));
writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
writeFileSync(path.join(root, 'small.txt'), 'alpha\nbeta\ngamma\n');
writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
writeFileSync(
  path.join(root, 'big.txt'),
  Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n') + '\n',
);
mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
writeFileSync(path.join(root, 'keep.tmp'), 'x');
writeFileSync(path.join(root, '.gitignore'), '*.tmp\nbuild/\n');
mkdirSync(path.join(root, 'build'));
writeFileSync(path.join(root, 'build', 'out.js'), 'ignored');
symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link'));
symlinkSync(outside, path.join(root, 'outside-dir'));
const home = os.homedir();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('工作区路径与读取', () => {
  it('只接受绝对、存在、目录的路径，并把软链解析成同一身份', async () => {
    const w = await import('@/server/projects/workspace');
    const actual = await w.validateWorkspacePath(root);
    expect(actual.workspacePath).toBe(root);
    const link = path.join(os.tmpdir(), `paimeng-link-${process.pid}`);
    symlinkSync(root, link);
    try {
      expect((await w.validateWorkspacePath(link)).workspacePath).toBe(root);
    } finally {
      rmSync(link, { force: true });
    }
    await expect(w.validateWorkspacePath('relative')).rejects.toMatchObject({ status: 400 });
    await expect(w.validateWorkspacePath(path.join(root, 'missing'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(w.validateWorkspacePath(path.join(root, 'small.txt'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(w.validateWorkspacePath('/')).rejects.toMatchObject({ status: 400 });
    await expect(w.validateWorkspacePath(home)).rejects.toMatchObject({ status: 400 });
    await expect(w.validateWorkspacePath(process.cwd())).rejects.toMatchObject({ status: 400 });
  });

  it('拒绝越界路径和指向项目外的软链', async () => {
    const w = await import('@/server/projects/workspace');
    await expect(w.resolveExistingPath(root, '../secret.txt')).rejects.toMatchObject({
      status: 403,
    });
    await expect(w.resolveExistingPath(root, outside)).rejects.toMatchObject({ status: 403 });
    await expect(w.resolveExistingPath(root, 'outside-link')).rejects.toMatchObject({
      status: 403,
    });
    await expect(w.resolveWritePath(root, '../new.txt')).rejects.toMatchObject({ status: 403 });
    await expect(w.resolveWritePath(root, 'outside-dir/new.txt')).rejects.toMatchObject({
      status: 403,
    });
    await expect(w.resolveWritePath(root, 'new-dir/new.txt')).resolves.toMatchObject({
      relative: 'new-dir/new.txt',
    });
  });

  it('按行读取一页，标明截断和续读位置；二进制不返回内容', async () => {
    const w = await import('@/server/projects/workspace');
    const small = await w.readFileWindow(path.join(root, 'small.txt'), 'small.txt', 2, 1);
    expect(small).toMatchObject({
      content: 'beta',
      offset: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
    const big = await w.readFileWindow(path.join(root, 'big.txt'), 'big.txt', 1, 10);
    expect(big.content.split('\n')).toHaveLength(10);
    expect(big.truncated).toBe(true);
    expect(big.nextOffset).toBe(11);
    const binary = await w.readFileWindow(path.join(root, 'binary.bin'), 'binary.bin');
    expect(binary.binary).toBe(true);
    expect(binary.content).toBe('');
  });

  it('索引忽略固定目录和 .gitignore，但显式读取不受索引限制', async () => {
    const w = await import('@/server/projects/workspace');
    const { paths } = await w.listProjectFiles(root, Infinity);
    expect(paths).toContain('small.txt');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('keep.tmp');
    expect(paths).not.toContain('build/out.js');
    expect((await w.resolveExistingPath(root, 'keep.tmp')).relative).toBe('keep.tmp');
  });
});
