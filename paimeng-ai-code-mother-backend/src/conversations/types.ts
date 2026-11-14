import type { AppUIMessage } from './ui-message'

export type { AppUIMessage, AppUIDataTypes, AppUIMessageChunk } from './ui-message'
export {
  appendText,
  assistantId,
  assistantMessage,
  finishMessage,
  messageText,
  userMessage,
  userId,
} from './ui-message'

export function messageVO(row: {
  id: number
  runId: string | null
  role: string
  status: string
  content: unknown
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    runId: row.runId,
    role: row.role,
    status: row.status,
    content: row.content as AppUIMessage,
    createTime: row.createdAt.toISOString(),
    updateTime: row.updatedAt.toISOString(),
  }
}
