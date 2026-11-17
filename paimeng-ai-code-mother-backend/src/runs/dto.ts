import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope, utcDateTime } from '../common/openapi'
import { planStepSchema } from '../conversations/dto'

const runIdSchema = z.string().uuid('runId 格式无效')
const runStatusValueSchema = z.enum(['running', 'cancelling', 'completed', 'failed', 'cancelled'])
const detailsStatusSchema = z.enum(['pending', 'ready', 'incomplete'])
const clientRequestIdSchema = z
  .string()
  .trim()
  .min(8, 'clientRequestId 长度需在 8-64 之间')
  .max(64, 'clientRequestId 长度需在 8-64 之间')

export const chatSchema = z.object({
  appId: z.number().int().positive('应用 ID 无效'),
  message: z.string().trim().min(1, '消息不能为空').max(1000, '消息最多 1000 个字符'),
  clientRequestId: clientRequestIdSchema,
})

export const enqueueMessageSchema = chatSchema.extend({
  mode: z.enum(['normal', 'steer']),
  runId: runIdSchema.optional(),
})
export const messageQueueQuerySchema = z.object({
  appId: z.coerce.number().int().positive(),
  clientRequestId: clientRequestIdSchema.optional(),
})
export const removeQueuedMessageSchema = z.object({
  appId: z.number().int().positive(),
  id: z.string().min(1).max(100),
})
export const resumeMessageQueueSchema = z.object({ appId: z.number().int().positive() })
export const queueItemSchema = z.object({
  id: z.string(),
  clientRequestId: z.string(),
  message: z.string(),
  mode: z.enum(['normal', 'steer']),
  status: z.enum(['queued', 'claimed', 'started', 'applied', 'returned', 'removed']),
  runId: z.string().nullable(),
})
export const messageQueueSchema = z.object({
  paused: z.boolean(),
  items: z.array(queueItemSchema),
  activeRun: z.object({ runId: z.string(), status: z.enum(['running', 'cancelling']) }).nullable(),
  requestedItem: queueItemSchema.nullable().optional(),
})

export const cancelRunSchema = z.object({ runId: runIdSchema })

export const runStatusQuerySchema = z.object({
  runId: runIdSchema.optional(),
  appId: z.coerce.number().int().positive('应用 ID 无效').optional(),
  clientRequestId: clientRequestIdSchema.optional(),
})

export const runDetailsQuerySchema = z.object({ runId: runIdSchema })

export const runActivitiesQuerySchema = z.object({
  runId: runIdSchema,
  afterId: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const runChangesQuerySchema = z.object({
  runId: runIdSchema,
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const runChangeDiffQuerySchema = z.object({
  runId: runIdSchema,
  fileId: z.coerce.number().int().positive('fileId 无效'),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const runValidationLogQuerySchema = z.object({
  runId: runIdSchema,
  attempt: z.coerce.number().int().positive('attempt 无效'),
  check: z.string().min(1, 'check 无效').max(40, 'check 无效'),
})

export const cancelRunResultSchema = z.object({ runId: z.string(), status: z.string() })

export const runStatusSchema = z.object({
  runId: z.string(),
  appId: z.number().int(),
  status: runStatusValueSchema,
  phase: z.string(),
  stepCount: z.number().int(),
  repairCount: z.number().int(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  detailsStatus: detailsStatusSchema.optional(),
  detailsError: z.string().nullable().optional(),
  startedAt: utcDateTime,
  deadlineAt: utcDateTime,
  finishedAt: utcDateTime.nullable(),
})

export const runPlanSchema = z.object({
  revision: z.number().int(),
  steps: z.array(planStepSchema),
  updatedAt: utcDateTime.optional(),
})

export const runValidationSchema = z.object({
  attempt: z.number().int(),
  check: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'skipped']),
  summary: z.string().nullable(),
  truncated: z.boolean(),
})

export const changeSummarySchema = z.object({
  filesChanged: z.number().int(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  complete: z.boolean(),
  partial: z.boolean(),
})

export const runDetailsSchema = z.object({
  runId: z.string(),
  appId: z.number().int(),
  status: runStatusValueSchema,
  phase: z.string(),
  stepCount: z.number().int(),
  repairCount: z.number().int(),
  startedAt: utcDateTime.nullable(),
  deadlineAt: utcDateTime.nullable(),
  finishedAt: utcDateTime.nullable(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  detailsStatus: detailsStatusSchema,
  detailsError: z.string().nullable(),
  plan: runPlanSchema.nullable(),
  validations: z.array(runValidationSchema),
  activityWatermark: z.number().int(),
  changes: changeSummarySchema,
})

export const runActivitySchema = z.object({
  id: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: utcDateTime,
})

export const runChangeSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'unchanged', 'pending']),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  diffStatus: z.enum(['ready', 'binary', 'too_large', 'error', 'pending']),
})

export const runChangePageSchema = z.object({
  records: z.array(runChangeSchema),
  nextCursor: z.string().nullable(),
})

export const runDiffPageSchema = z.object({
  fileId: z.number().int(),
  path: z.string(),
  status: z.string(),
  lines: z.array(z.string()),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
})

export const runValidationLogSchema = z.object({
  attempt: z.number().int(),
  check: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  logs: z.string().nullable(),
  truncated: z.boolean(),
})

export const runStartedChunkSchema = z.object({
  type: z.literal('data-run-started'),
  data: z.object({ runId: z.string(), status: z.string() }),
})

export const phaseChunkSchema = z.object({
  type: z.literal('data-phase'),
  data: z.object({ runId: z.string(), phase: z.string() }),
})

export const runChunkSchema = z.object({
  type: z.literal('data-run'),
  data: z.object({
    runId: z.string(),
    status: z.string(),
    errorCode: z.string().nullable().optional(),
    errorSummary: z.string().nullable().optional(),
    stepCount: z.number().int().optional(),
    repairCount: z.number().int().optional(),
    detailsStatus: detailsStatusSchema.optional(),
    detailsError: z.string().nullable().optional(),
    changes: changeSummarySchema.nullable().optional(),
  }),
})

export class ChatDto extends createZodDto(chatSchema) {}
export class EnqueueMessageDto extends createZodDto(enqueueMessageSchema) {}
export class MessageQueueQueryDto extends createZodDto(messageQueueQuerySchema) {}
export class RemoveQueuedMessageDto extends createZodDto(removeQueuedMessageSchema) {}
export class ResumeMessageQueueDto extends createZodDto(resumeMessageQueueSchema) {}
export class BaseResponseQueueItem extends createZodDto(envelope(queueItemSchema)) {}
export class BaseResponseMessageQueue extends createZodDto(envelope(messageQueueSchema)) {}
export class CancelRunDto extends createZodDto(cancelRunSchema) {}
export class RunStatusQueryDto extends createZodDto(runStatusQuerySchema) {}
export class RunDetailsQueryDto extends createZodDto(runDetailsQuerySchema) {}
export class RunActivitiesQueryDto extends createZodDto(runActivitiesQuerySchema) {}
export class RunChangesQueryDto extends createZodDto(runChangesQuerySchema) {}
export class RunChangeDiffQueryDto extends createZodDto(runChangeDiffQuerySchema) {}
export class RunValidationLogQueryDto extends createZodDto(runValidationLogQuerySchema) {}
export class RunStatus extends createZodDto(runStatusSchema) {}
export class RunDetails extends createZodDto(runDetailsSchema) {}
export class RunActivity extends createZodDto(runActivitySchema) {}
export class RunChangePage extends createZodDto(runChangePageSchema) {}
export class RunDiffPage extends createZodDto(runDiffPageSchema) {}
export class RunValidationLog extends createZodDto(runValidationLogSchema) {}
export class CancelRunResult extends createZodDto(cancelRunResultSchema) {}
export class RunStartedChunk extends createZodDto(runStartedChunkSchema) {}
export class PhaseChunk extends createZodDto(phaseChunkSchema) {}
export class RunChunk extends createZodDto(runChunkSchema) {}
export class BaseResponseRunStatus extends createZodDto(envelope(runStatusSchema)) {}
export class BaseResponseRunDetails extends createZodDto(envelope(runDetailsSchema)) {}
export class BaseResponseRunActivityList extends createZodDto(envelope(z.array(runActivitySchema))) {}
export class BaseResponseRunChangePage extends createZodDto(envelope(runChangePageSchema)) {}
export class BaseResponseRunDiffPage extends createZodDto(envelope(runDiffPageSchema)) {}
export class BaseResponseRunValidationLog extends createZodDto(envelope(runValidationLogSchema)) {}
export class BaseResponseCancelRun extends createZodDto(envelope(cancelRunResultSchema)) {}
