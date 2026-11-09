// mock 世界的 id 生成器：前缀可读，便于在响应里辨认实体类型。

let seq = 0;

export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
