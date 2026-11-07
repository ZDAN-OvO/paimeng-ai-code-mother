import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Spike 度量器：在容器内遍历若干根目录，统计
 * - 条目数 / 文件数 / 目录数 / 符号链接数
 * - 表面字节（size）与分配块（blocks * 512）
 * - 按 dev:ino 去重后的分配块（近似 du）
 * - 硬链接数 > 1 的文件数
 * - 指定样本路径的 dev/ino/nlink/realpath
 *
 * 用法：node measure.mjs <root> [<root> ...] label=path ...
 * 输出 JSON 到 stdout。
 */

const args = process.argv.slice(2);
const roots = [];
const samples = [];
for (const arg of args) {
  const index = arg.indexOf('=');
  if (index > 0) samples.push({ label: arg.slice(0, index), path: arg.slice(index + 1) });
  else roots.push(arg);
}

async function walk(root) {
  const stats = { root, entries: 0, files: 0, dirs: 0, symlinks: 0, bytes: 0, blocks: 0, hardlinked: 0, maxNlink: 0 };
  const unique = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      stats.entries += 1;
      if (info.isSymbolicLink()) { stats.symlinks += 1; continue; }
      if (info.isDirectory()) { stats.dirs += 1; await visit(absolute); continue; }
      if (!info.isFile()) continue;
      stats.files += 1;
      stats.bytes += info.size;
      stats.blocks += info.blocks * 512;
      if (info.nlink > 1) stats.hardlinked += 1;
      stats.maxNlink = Math.max(stats.maxNlink, info.nlink);
      const key = `${info.dev}:${info.ino}`;
      const known = unique.get(key);
      if (known) { known.links += 1; continue; }
      unique.set(key, { size: info.size, blocks: info.blocks * 512, links: 1 });
    }
  }
  await visit(root);
  stats.uniqueInodes = unique.size;
  stats.uniqueBytes = [...unique.values()].reduce((sum, item) => sum + item.size, 0);
  stats.uniqueBlocks = [...unique.values()].reduce((sum, item) => sum + item.blocks, 0);
  return stats;
}

const result = { roots: [], samples: [], union: null };
const all = new Map();
for (const root of roots) {
  const stats = await walk(root);
  result.roots.push(stats);
  const prefix = root + '/';
  // 二次遍历只取 dev:ino，逐个根合并；上面已经把统计做完，这里重新读一遍不追求性能。
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await collect(absolute); continue; }
      if (!info.isFile()) continue;
      const key = `${info.dev}:${info.ino}`;
      const known = all.get(key);
      if (!known) all.set(key, { size: info.size, blocks: info.blocks * 512 });
    }
  }
  await collect(root).catch(() => undefined);
  void prefix;
}
result.union = {
  uniqueInodes: all.size,
  uniqueBytes: [...all.values()].reduce((sum, item) => sum + item.size, 0),
  uniqueBlocks: [...all.values()].reduce((sum, item) => sum + item.blocks, 0),
};

for (const sample of samples) {
  try {
    const resolved = await realpath(sample.path);
    const info = await stat(sample.path);
    result.samples.push({
      label: sample.label,
      path: sample.path,
      realpath: resolved,
      dev: info.dev,
      ino: info.ino,
      nlink: info.nlink,
      size: info.size,
      blocks: info.blocks * 512,
    });
  } catch (error) {
    result.samples.push({ label: sample.label, path: sample.path, error: String(error) });
  }
}

console.log(JSON.stringify(result, null, 2));
