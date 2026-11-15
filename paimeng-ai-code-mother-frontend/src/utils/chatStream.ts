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

export function chatStreamEventType(type: string): string {
  if (type === 'data-run') return 'run-finished'
  if (type === 'data-plan') return 'plan-updated'
  if (type === 'data-validation') return 'validation-status'
  if (type === 'data-model') return 'model-status'
  if (type === 'data-preview') return 'preview-status'
  return type.slice(5)
}
