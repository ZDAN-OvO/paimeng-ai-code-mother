// 时间格式在服务端与浏览器之间必须一致，所以统一按东八区切片，不用本地时区。

/** 固定按东八区生成 ISO 字符串，格式与种子数据一致。 */
export function addSeconds(iso: string, seconds: number): string {
  const time = Date.parse(iso) + seconds * 1000;
  const shifted = new Date(time + 8 * 3600_000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

export function nowIso(): string {
  const shifted = new Date(Date.now() + 8 * 3600_000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

export function formatTime(iso: string): string {
  // 固定按 ISO 字符串切片，服务端与浏览器渲染结果一致。
  const day = iso.slice(5, 10).replace('-', '/');
  const time = iso.slice(11, 16);
  return `${day} ${time}`;
}
