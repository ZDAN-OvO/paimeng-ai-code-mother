import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstallMarker, writeInstallMarker } from '@/server/runtime/dependencies';

/**
 * 安装标记是平台写在 Workspace 里的普通文件。Workspace 里的代码可以预置同名软链接，
 * 标记读写都必须拒绝跟随，否则一次安装就能改写 Workspace 外的文件。
 */

let root = '';
const pair = { imageIdentity: 'image@sha', lockDigest: 'a'.repeat(64), storeRoot: '/store/runs/x' };

describe('安装标记', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'marker-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('写入后能读回镜像、锁与 store 三项', async () => {
    await writeInstallMarker(root, pair);
    expect(await readInstallMarker(root)).toEqual(pair);
  });

  it('目标是指向 Workspace 外的软链接时拒绝写入，外部文件保持原样', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'sentinel');
    const link = join(root, '.paimeng-dependencies.json');
    await rm(link, { force: true });
    await symlink(outside, link);

    await expect(writeInstallMarker(root, pair)).rejects.toThrow(/依赖来源不被允许/);
    expect(await readFile(outside, 'utf8')).toBe('sentinel');
    expect(await readInstallMarker(root)).toBeNull();
  });
});
