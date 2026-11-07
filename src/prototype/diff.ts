import type { DiffLine, FileMap } from './types';

/** 行级 LCS diff。原型里文件都很小，O(n·m) 足够。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i], oldNo: i + 1 });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j], newNo: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ type: 'del', text: a[i], oldNo: i + 1 });
    i += 1;
  }
  while (j < b.length) {
    out.push({ type: 'add', text: b[j], newNo: j + 1 });
    j += 1;
  }
  return out;
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
