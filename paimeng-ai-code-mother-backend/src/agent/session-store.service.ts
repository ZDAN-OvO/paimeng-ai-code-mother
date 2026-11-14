import { Injectable } from '@nestjs/common'
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'
import { asc, eq, sql } from 'drizzle-orm'
import { DbService } from '../db/db.module'
import { agentSessionEntries, SessionEntryRow } from '../db/schema'
import { truncateBytes } from '../common/truncate'

export interface AssistantEntryPayload {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; invalid?: boolean }>
}

@Injectable()
export class SessionStoreService {
  constructor(private readonly db: DbService) {}

  async append(conversationId: number, runId: string, entryType: string, payload: unknown) {
    const [{ next }] = await this.db.db
      .select({ next: sql<number>`coalesce(max(${agentSessionEntries.seq}), 0) + 1` })
      .from(agentSessionEntries)
      .where(eq(agentSessionEntries.conversationId, conversationId))
    const [row] = await this.db.db
      .insert(agentSessionEntries)
      .values({ conversationId, runId, seq: Number(next), entryType, payload: payload as object })
      .returning()
    return row
  }

  async list(conversationId: number): Promise<SessionEntryRow[]> {
    return this.db.db
      .select()
      .from(agentSessionEntries)
      .where(eq(agentSessionEntries.conversationId, conversationId))
      .orderBy(asc(agentSessionEntries.seq), asc(agentSessionEntries.id))
  }

  async ensureToolResults(conversationId: number, runId: string, reason: string) {
    const rows = await this.list(conversationId)
    const completed = new Set(
      rows
        .filter((row) => row.runId === runId && row.entryType === 'tool')
        .map((row) => (row.payload as { toolCallId?: string }).toolCallId)
        .filter((id): id is string => Boolean(id)),
    )
    for (const row of rows) {
      if (row.runId !== runId || row.entryType !== 'assistant') continue
      const payload = row.payload as AssistantEntryPayload
      for (const call of payload.toolCalls ?? []) {
        if (completed.has(call.toolCallId)) continue
        await this.append(conversationId, runId, 'tool', {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: JSON.stringify({ error: reason }),
        })
        completed.add(call.toolCallId)
      }
    }
  }

  toModelMessages(rows: SessionEntryRow[], toolOutputMaxBytes: number): ModelMessage[] {
    const messages: ModelMessage[] = []
    const invalidCalls = new Set<string>()
    for (const row of rows) {
      if (row.entryType === 'user') {
        const payload = row.payload as { text: string }
        messages.push({ role: 'user', content: [{ type: 'text', text: payload.text }] })
      } else if (row.entryType === 'assistant') {
        const payload = row.payload as AssistantEntryPayload
        const content: Array<{ type: 'text'; text: string } | ToolCallPart> = []
        if (payload.text) content.push({ type: 'text', text: payload.text })
        for (const call of payload.toolCalls ?? []) {
          if (
            call.invalid === true ||
            !call.input ||
            typeof call.input !== 'object' ||
            Array.isArray(call.input)
          ) {
            invalidCalls.add(JSON.stringify([row.runId, call.toolCallId]))
            content.push({
              type: 'text',
              text: `工具 ${call.toolName.slice(0, 64)} 调用失败：参数无效或被截断，工具未执行。请使用完整且较小的对象参数重新调用。`,
            })
            continue
          }
          content.push({
            type: 'tool-call',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })
        }
        if (content.length) messages.push({ role: 'assistant', content })
      } else if (row.entryType === 'tool') {
        const payload = row.payload as { toolCallId: string; toolName: string; output: string }
        if (invalidCalls.has(JSON.stringify([row.runId, payload.toolCallId]))) continue
        const output = truncateBytes(payload.output ?? '', toolOutputMaxBytes)
        const part: ToolResultPart = {
          type: 'tool-result',
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          output: { type: 'text', value: output.text },
        }
        messages.push({ role: 'tool', content: [part] })
      } else if (row.entryType === 'system_note') {
        const payload = row.payload as { text: string }
        messages.push({ role: 'system', content: payload.text })
      }
    }
    return messages
  }
}
