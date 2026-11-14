export function modelProgressText(payload: Record<string, unknown>): string {
  if (payload.status === 'running') return '正在思考…'
  if (payload.status !== 'streaming') return ''
  const label =
    payload.tool === 'write' ? '正在编写文件' : payload.tool === 'edit' ? '正在修改文件' : ''
  if (!label) return '正在生成…'
  const bytes = payload.inputBytes
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return label
  const kb = Math.max(0.1, Math.round((bytes / 1024) * 10) / 10)
  return `${label} · 已接收 ${kb} KB`
}
