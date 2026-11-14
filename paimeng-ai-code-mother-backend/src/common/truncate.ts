export interface TruncatedText {
  text: string
  truncated: boolean
  originalBytes: number
}

export function truncateBytes(input: string, maxBytes: number): TruncatedText {
  const buffer = Buffer.from(input, 'utf8')
  if (buffer.length <= maxBytes) {
    return { text: input, truncated: false, originalBytes: buffer.length }
  }
  const kept = buffer.subarray(0, maxBytes).toString('utf8')
  const marker = `\n\n[输出已截断：原始 ${buffer.length} 字节，仅保留前 ${maxBytes} 字节]`
  return { text: kept + marker, truncated: true, originalBytes: buffer.length }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  return { name: 'Error', message: String(err) }
}
