import { describe, expect, it } from 'vitest';
import { commitLimitViolation, formatBytes, type CommitLimits } from '@/server/versioning/commit-limits';
import { getConfig } from '@/server/infra/config';

const limits: CommitLimits = { maxFiles: 3, maxBytes: 100, maxFileBytes: 60 };

describe('提交配额', () => {
  it('文件数超过上限时说明改动数量与上限', () => {
    const message = commitLimitViolation([
      { path: 'a.html', bytes: 1 },
      { path: 'b.html', bytes: 1 },
      { path: 'c.html', bytes: 1 },
      { path: 'd.html', bytes: 1 },
    ], limits);
    expect(message).toContain('4 个文件');
    expect(message).toContain('最多 3 个文件');
  });

  it('单个文件超过上限时点名该文件，便于直接处理', () => {
    const message = commitLimitViolation([
      { path: 'assets/hero.png', bytes: 61 },
      { path: 'index.html', bytes: 10 },
    ], limits);
    expect(message).toContain('assets/hero.png');
    expect(message).toContain('60 B');
  });

  it('总量超过上限时给出合计与上限', () => {
    const message = commitLimitViolation([
      { path: 'a.bin', bytes: 50 },
      { path: 'b.bin', bytes: 51 },
    ], limits);
    expect(message).toContain('101 B');
    expect(message).toContain('100 B');
  });

  it('等于上限时放行，超过一个字节才拒绝', () => {
    expect(commitLimitViolation([
      { path: 'a', bytes: 50 },
      { path: 'b', bytes: 50 },
    ], limits)).toBeNull();
    expect(commitLimitViolation([
      { path: 'a', bytes: 50 },
      { path: 'b', bytes: 51 },
    ], limits)).not.toBeNull();
  });

  it('人可读的体积按二进制单位换算', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MiB');
  });
});

describe('提交配额配置', () => {
  it('默认是 1000 个文件、50 MiB 总量、单文件 10 MiB，并可用环境变量覆盖', () => {
    const names = ['COMMIT_MAX_FILES', 'COMMIT_MAX_BYTES', 'COMMIT_MAX_FILE_BYTES'] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(getConfig().commitLimits).toEqual({ maxFiles: 1000, maxBytes: 50 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024 });
      process.env.COMMIT_MAX_FILES = '7';
      process.env.COMMIT_MAX_BYTES = '2048';
      process.env.COMMIT_MAX_FILE_BYTES = '1024';
      expect(getConfig().commitLimits).toEqual({ maxFiles: 7, maxBytes: 2048, maxFileBytes: 1024 });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
