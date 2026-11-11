import { describe, expect, it } from 'vitest';
import { undoChangeSet } from './change-set';
import type { ChangeSet, FileMap } from '@/shared/api/schemas';

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: 'cs_2',
    seq: 2,
    chatId: 'chat_1',
    messageId: 'msg_2',
    summary: '第二轮',
    createdAt: '2026-11-11T10:00:00+08:00',
    status: 'applied',
    changedFiles: ['app/page.tsx'],
    before: { 'app/page.tsx': 'v1' },
    after: { 'app/page.tsx': 'v2' },
    siteBefore: null,
    siteAfter: null,
    ...overrides,
  };
}

describe('改动记录撤销（mock 项目共享态）', () => {
  it('撤销只回退这一轮动过的文件，其余文件保持当前磁盘内容', () => {
    const files: FileMap = {
      'app/page.tsx': 'v2',
      'app/about.tsx': '未被这一轮改过',
    };
    expect(undoChangeSet(files, changeSet())).toEqual({
      ok: true,
      files: { 'app/page.tsx': 'v1', 'app/about.tsx': '未被这一轮改过' },
    });
  });

  it('撤销新增文件会把它从当前文件里删掉', () => {
    const files = { 'app/page.tsx': 'v1', 'notes.md': 'new' };
    const result = undoChangeSet(
      files,
      changeSet({ changedFiles: ['notes.md'], before: {}, after: { 'notes.md': 'new' } }),
    );
    expect(result).toEqual({ ok: true, files: { 'app/page.tsx': 'v1' } });
  });

  it('后续一轮又改了同一个文件时不盲覆盖，列出冲突文件', () => {
    const files = { 'app/page.tsx': 'v3・后续编辑' };
    expect(undoChangeSet(files, changeSet())).toEqual({
      ok: false,
      reason: 'conflict',
      conflicts: ['app/page.tsx'],
    });
  });

  it('文件在外部编辑器里被改过也按冲突处理', () => {
    const files = { 'app/page.tsx': 'v2' };
    const edited = undoChangeSet(files, changeSet());
    expect(edited.ok).toBe(true);
    // 磁盘上后来被别人改成了 v2-外部：撤销必须拒绝。
    expect(undoChangeSet({ 'app/page.tsx': 'v2-外部' }, changeSet())).toMatchObject({
      ok: false,
      reason: 'conflict',
      conflicts: ['app/page.tsx'],
    });
  });

  it('后续一轮改的是别的文件时仍然可以撤销', () => {
    const files = { 'app/page.tsx': 'v2', 'app/about.tsx': 'v3' };
    const result = undoChangeSet(files, changeSet());
    expect(result).toEqual({
      ok: true,
      files: { 'app/page.tsx': 'v1', 'app/about.tsx': 'v3' },
    });
  });

  it('已经撤销过的记录不能再撤销一次', () => {
    expect(undoChangeSet({ 'app/page.tsx': 'v1' }, changeSet({ status: 'undone' }))).toEqual({
      ok: false,
      reason: 'already-undone',
      conflicts: [],
    });
  });
});
