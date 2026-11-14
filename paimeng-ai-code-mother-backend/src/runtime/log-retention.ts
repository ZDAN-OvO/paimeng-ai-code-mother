import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 单次日志保留尾部，优先保留最后的错误信息。
 */
export function truncateLogTail(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.length <= maxBytes) return content
  return buffer.subarray(buffer.length - maxBytes).toString('utf8')
}

/**
 * 按修改时间保留最新日志，直到该应用日志总量不超过上限。
 */
export async function pruneLogDir(dir: string, maxBytes: number): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = join(dir, entry.name)
        const info = await stat(full).catch(() => null)
        return info ? { full, size: info.size, mtimeMs: info.mtimeMs } : null
      }),
  )
  let total = 0
  for (const file of files
    .filter((file): file is { full: string; size: number; mtimeMs: number } => Boolean(file))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    total += file.size
    if (total > maxBytes) await rm(file.full, { force: true }).catch(() => undefined)
  }
}
