import type { ChangeSet, FileMap } from '@/shared/api/schemas';

export type UndoOutcome =
  | { ok: true; files: FileMap }
  | { ok: false; reason: 'already-undone' | 'conflict'; conflicts: string[] };

/**
 * 撤销一轮改动前的安全检查：只在这一轮动过的文件仍然等于当时写入的结果时，
 * 才把它们写回 `before`。后续对话或外部编辑器改过任何一个文件都算冲突，
 * 宁可拒绝也不盲覆盖磁盘上的内容。
 */
export function undoChangeSet(files: FileMap, changeSet: ChangeSet): UndoOutcome {
  if (changeSet.status !== 'applied') {
    return { ok: false, reason: 'already-undone', conflicts: [] };
  }
  const conflicts = changeSet.changedFiles.filter(
    (path) => (files[path] ?? null) !== (changeSet.after[path] ?? null),
  );
  if (conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts };

  const next: FileMap = { ...files };
  for (const path of changeSet.changedFiles) {
    const before = changeSet.before[path];
    if (before === undefined) delete next[path];
    else next[path] = before;
  }
  return { ok: true, files: next };
}
