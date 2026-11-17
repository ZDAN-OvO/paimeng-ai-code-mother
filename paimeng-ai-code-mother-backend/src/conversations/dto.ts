import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope, utcDateTime } from '../common/openapi'

export const appIdParamSchema = z.object({
  appId: z.coerce.number().int('应用 ID 无效').positive('应用 ID 无效'),
})

export const chatHistoryQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export const uiMessagePartSchema = z.union([
  z.object({
    type: z.literal('data-steer'),
    id: z.string(),
    data: z.object({ text: z.string(), clientRequestId: z.string() }),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string(),
    state: z.enum(['streaming', 'done']).optional(),
  }),
  z.object({
    type: z.literal('dynamic-tool'),
    dynamic: z.literal(true).optional(),
    toolName: z.string(),
    toolCallId: z.string(),
    state: z.enum(['input-streaming', 'input-available', 'output-available', 'output-error']),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    errorText: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal('data-plan'),
    id: z.string(),
    data: z.object({ revision: z.number().int(), steps: z.array(planStepSchema) }),
  }),
  z.object({
    type: z.literal('data-validation'),
    id: z.string(),
    data: z.object({
      attempt: z.number().int(),
      check: z.string().optional(),
      status: z.enum(['running', 'passed', 'failed', 'skipped']),
      message: z.string().optional(),
    }),
  }),
])

export const chatUIMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parts: z.array(uiMessagePartSchema),
})

export const messageVoSchema = z.object({
  id: z.number().int(),
  runId: z.string().nullable(),
  role: z.enum(['user', 'assistant']),
  status: z.enum(['completed', 'streaming', 'failed', 'cancelled']),
  content: chatUIMessageSchema,
  createTime: utcDateTime,
  updateTime: utcDateTime,
})

export const chatHistorySchema = z.object({
  records: z.array(messageVoSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
})

export class AppIdParamDto extends createZodDto(appIdParamSchema) {}
export class ChatHistoryQueryDto extends createZodDto(chatHistoryQuerySchema) {}
export class ChatUIMessage extends createZodDto(chatUIMessageSchema) {}
export const uiMessagePartWrapperSchema = z.object({ part: uiMessagePartSchema })
export class UIMessagePart extends createZodDto(uiMessagePartWrapperSchema) {}
export class MessageVO extends createZodDto(messageVoSchema) {}
export class BaseResponseChatHistory extends createZodDto(envelope(chatHistorySchema)) {}
