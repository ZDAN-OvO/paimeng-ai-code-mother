/**
 * 一次版本提交允许携带的内容上限。
 *
 * 平台在提交前对整个 worktree 差异做检查：模型用文件工具写、直接写磁盘、shell 写，
 * 走的都是同一条提交入口，所以这里同时就是「一条命令不能把任意数据塞进版本历史」的闸。
 */
export type CommitLimits = {
  /** 本次改动最多包含多少个文件（新增、修改、删除都计数）。 */
  maxFiles: number;
  /** 本次改动涉及的源码文件在提交后合计最多多少字节。 */
  maxBytes: number;
  /** 单个文件在提交后最多多少字节。 */
  maxFileBytes: number;
};

export type CommitEntry = { path: string; bytes: number };

const units = ['B', 'KiB', 'MiB', 'GiB'];

/** 给用户看的体积：整数单位不带小数，其余保留一位，避免出现 50.0000001 MiB。 */
export function formatBytes(bytes: number) {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/** 返回第一条超限的中文原因；没有超限返回 null。 */
export function commitLimitViolation(entries: readonly CommitEntry[], limits: CommitLimits): string | null {
  if (entries.length > limits.maxFiles) {
    return `本次改动有 ${entries.length} 个文件，超过单次最多 ${limits.maxFiles} 个文件的限制。请拆分改动，或删除不需要的文件后再提交。`;
  }
  const oversized = entries.find(entry => entry.bytes > limits.maxFileBytes);
  if (oversized) {
    return `文件「${oversized.path}」有 ${formatBytes(oversized.bytes)}，超过单文件 ${formatBytes(limits.maxFileBytes)} 的限制。请压缩这个文件或换一种实现方式。`;
  }
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total > limits.maxBytes) {
    return `本次改动合计 ${formatBytes(total)}，超过单次 ${formatBytes(limits.maxBytes)} 的限制。请减少文件或压缩素材后再提交。`;
  }
  return null;
}
