import { describe, expect, it } from 'vitest';
import { clearUndoNotices, notifyUndo, takeUndoNotices } from '@/server/agent/notices';

describe('撤销通知', () => {
  it('同项目每个运行轮次都能收到同一条撤销通知', () => {
    clearUndoNotices();
    notifyUndo('project-a', ['src/a.ts']);
    expect(takeUndoNotices('project-a', 'run-1')).toHaveLength(1);
    expect(takeUndoNotices('project-a', 'run-2')).toHaveLength(1);
    expect(takeUndoNotices('project-a', 'run-1')).toEqual([]);
  });

  it('通知不跨项目，且包含路径', () => {
    clearUndoNotices();
    notifyUndo('project-a', ['src/a.ts', 'src/b.ts']);
    expect(takeUndoNotices('project-b', 'run-1')).toEqual([]);
    expect(takeUndoNotices('project-a', 'run-1').join('\n')).toContain('src/b.ts');
  });
});
