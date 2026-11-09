import { describe, expect, it } from 'vitest';
import { changedPaths, diffLines, diffStats } from './diff';

describe('行级 diff', () => {
  it('找出新增、删除与未变化的行', () => {
    const lines = diffLines('a\nb\nc', 'a\nc\nd');
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.filter((line) => line.type === 'same').map((line) => line.text)).toEqual([
      'a',
      'c',
    ]);
  });

  it('只把真正变化的文件算进版本', () => {
    expect(changedPaths({ 'a.tsx': '1', 'b.tsx': '2' }, { 'a.tsx': '1', 'b.tsx': '3' })).toEqual([
      'b.tsx',
    ]);
  });
});
