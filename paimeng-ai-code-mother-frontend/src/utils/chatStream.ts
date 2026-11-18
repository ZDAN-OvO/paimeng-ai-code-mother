import type { ChatUIMessage } from '@/api/chatTypes'

export const assistantMessageId = (runId: string) => `assistant:${runId}`

export function applyMessageReplay<T extends { runId: string | null; message: ChatUIMessage }>(
  items: readonly T[],
  runId: string,
  snapshot: ChatUIMessage,
  create: () => T,
): { items: T[]; item: T } {
  const message: ChatUIMessage = {
    ...snapshot,
    id: assistantMessageId(runId),
    role: 'assistant',
  }
  const index = items.findIndex(
    (item) =>
      item.message.role === 'assistant' && (item.runId === runId || item.message.id === message.id),
  )
  if (index >= 0) {
    const item = { ...items[index], runId, message }
    return {
      items: items.map((entry, entryIndex) => (entryIndex === index ? item : entry)),
      item,
    }
  }
  const created = { ...create(), runId, message }
  return { items: [...items, created], item: created }
}

// 流式历史可能落后于 SSE；只有落库后的终态快照才能替换本地实时内容。
export function mergeHistoryWithLiveMessages<
  T extends {
    id: number | null
    runId: string | null
    status: string
    message: ChatUIMessage
  },
>(records: readonly T[], items: readonly T[], liveRunIds: ReadonlySet<string>): T[] {
  const live = new Map(
    items
      .filter(
        (item) => item.message.role === 'assistant' && item.runId && liveRunIds.has(item.runId),
      )
      .map((item) => [item.runId, item]),
  )
  const seen = new Set<string>()
  const merged = records.map((record) => {
    if (record.message.role !== 'assistant' || !record.runId) return record
    seen.add(record.runId)
    const current = live.get(record.runId)
    return current && record.status === 'streaming' ? { ...current, id: record.id } : record
  })
  // 历史查询也可能早于助手行创建，仍须保留已从流中收到的消息。
  for (const [id, item] of live) {
    if (id && !seen.has(id)) merged.push(item)
  }
  return merged
}

export function chatStreamEventType(type: string): string {
  if (type === 'data-run') return 'run-finished'
  if (type === 'data-plan') return 'plan-updated'
  if (type === 'data-validation') return 'validation-status'
  if (type === 'data-model') return 'model-status'
  if (type === 'data-preview') return 'preview-status'
  return type.slice(5)
}
