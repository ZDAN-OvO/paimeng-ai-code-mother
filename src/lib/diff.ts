import { diffArrays } from 'diff';

type FileMap = Record<string, string>;

export type DiffLine = {
  type: 'add' | 'del' | 'same';
  text: string;
  oldNo?: number;
  newNo?: number;
};

/** 按现有行语义比较：保留空行、末尾换行与两侧行号。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const changes = diffArrays(
    before.length ? before.split('\n') : [],
    after.length ? after.split('\n') : [],
  );
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const change of changes) {
    for (const text of change.value) {
      if (change.removed) lines.push({ type: 'del', text, oldNo: oldNo++ });
      else if (change.added) lines.push({ type: 'add', text, newNo: newNo++ });
      else lines.push({ type: 'same', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return lines;
}

export function diffStats(lines: DiffLine[]) {
  return {
    added: lines.filter((line) => line.type === 'add').length,
    removed: lines.filter((line) => line.type === 'del').length,
  };
}

/** 两份源码树之间新增、删除、修改的文件路径。 */
export function changedPaths(before: FileMap, after: FileMap): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

/** 折叠未变化的行，保留 N 行上下文。 */
export function collapseUnchanged(lines: DiffLine[], context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep[k] = true;
    }
  });

  const out: (DiffLine | { type: 'gap'; text: string })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ type: 'gap', text: `… ${skipped} 行未变化` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ type: 'gap', text: `… ${skipped} 行未变化` });
  return out;
}
