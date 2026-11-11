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

  it.each([
    ['', ''],
    ['', '第一行\n'],
    ['第一行\n', ''],
    ['a\nb', 'a\nb\n'],
    ['\n\n', '\n'],
    ['a\nb\na\nb', 'a\na\nb\nb'],
    ['中文\r\n第二行', '中文\r\n更新'],
  ])('比较边界文本后仍能按行号还原两边：%j → %j', (before, after) => {
    const lines = diffLines(before, after);
    const oldLines = lines.filter((line) => line.type !== 'add');
    const newLines = lines.filter((line) => line.type !== 'del');
    expect(oldLines.map((line) => line.text)).toEqual(before ? before.split('\n') : []);
    expect(newLines.map((line) => line.text)).toEqual(after ? after.split('\n') : []);
    expect(oldLines.map((line) => line.oldNo)).toEqual(oldLines.map((_, index) => index + 1));
    expect(newLines.map((line) => line.newNo)).toEqual(newLines.map((_, index) => index + 1));
  });

  it('替换行保留删除在前、新增在后的展示顺序', () => {
    expect(diffLines('标题\n旧内容\n结尾', '标题\n新内容\n结尾')).toEqual([
      { type: 'same', text: '标题', oldNo: 1, newNo: 1 },
      { type: 'del', text: '旧内容', oldNo: 2 },
      { type: 'add', text: '新内容', newNo: 2 },
      { type: 'same', text: '结尾', oldNo: 3, newNo: 3 },
    ]);
  });

  it('较大文件局部修改保持准确的行号与变化统计', () => {
    const before = Array.from({ length: 20000 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[10000] = 'updated line';
    const result = diffLines(before.join('\n'), after.join('\n'));
    expect(diffStats(result)).toEqual({ added: 1, removed: 1 });
    expect(result.filter((line) => line.type !== 'same')).toEqual([
      { type: 'del', text: 'line 10000', oldNo: 10001 },
      { type: 'add', text: 'updated line', newNo: 10001 },
    ]);
  });

  it('只把真正变化的文件算进改动记录', () => {
    expect(changedPaths({ 'a.tsx': '1', 'b.tsx': '2' }, { 'a.tsx': '1', 'b.tsx': '3' })).toEqual([
      'b.tsx',
    ]);
  });
});
