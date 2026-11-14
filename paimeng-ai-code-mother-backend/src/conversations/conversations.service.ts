import { Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import { ApiException } from '../common/api'
import { DbService } from '../db/db.module'
import { apps, conversations, messages } from '../db/schema'
import { messageVO } from './types'

export interface HistoryQuery {
  appId: number
  cursor?: string
  pageSize?: number
}

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

function encodeCursor(id: number): string {
  return Buffer.from(`v1:${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const match = /^v1:(\d+)$/.exec(raw)
    if (!match) return null
    return Number(match[1])
  } catch {
    return null
  }
}

@Injectable()
export class ConversationsService {
  constructor(private readonly db: DbService) {}

  async getHistory(userId: number, query: HistoryQuery) {
    const [app] = await this.db.db
      .select({ id: apps.id, ownerId: apps.ownerId, status: apps.status })
      .from(apps)
      .where(eq(apps.id, query.appId))
      .limit(1)
    if (!app) throw ApiException.notFound('应用不存在')
    if (app.ownerId !== userId) throw ApiException.forbidden('无权查看该应用的对话')

    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const cursorId = decodeCursor(query.cursor)
    if (query.cursor && cursorId === null && query.cursor !== '') {
      throw ApiException.badRequest('无效的分页游标')
    }

    const [conversation] = await this.db.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.appId, query.appId))
      .limit(1)
    if (!conversation) throw ApiException.notFound('应用会话不存在')

    const where = cursorId
      ? and(eq(messages.conversationId, conversation.id), lt(messages.id, cursorId))
      : eq(messages.conversationId, conversation.id)

    const rows = await this.db.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.id))
      .limit(pageSize + 1)

    const hasMore = rows.length > pageSize
    const page = rows.slice(0, pageSize)
    const oldest = page.length > 0 ? page[page.length - 1] : null
    return {
      records: page.reverse().map((row) => messageVO(row)),
      nextCursor: hasMore && oldest ? encodeCursor(oldest.id) : null,
      hasMore,
    }
  }

  async listNewMessages(conversationId: number, afterId: number) {
    const rows = await this.db.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.id, afterId)))
      .orderBy(asc(messages.id))
    return rows.map(messageVO)
  }
}
