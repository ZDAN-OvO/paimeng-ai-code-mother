import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope, utcDateTime } from '../common/openapi'

export const appIdSchema = z.object({
  id: z.coerce.number({ message: '应用 ID 无效' }).int('应用 ID 无效').positive('应用 ID 无效'),
})

export const appIdBodySchema = z.object({
  id: z.number().int('应用 ID 无效').positive('应用 ID 无效'),
})

export const addAppSchema = z.object({
  initPrompt: z.string().trim().min(1, '提示词不能为空').max(1000, '提示词最多 1000 个字符'),
})

export const updateAppSchema = z.object({
  id: z.number().int().positive(),
  appName: z.string().trim().min(1, '应用名称不能为空').max(50, '应用名称最多 50 个字符'),
})

export const listAppQuerySchema = z.object({
  pageNum: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  sortField: z.enum(['createTime', 'updateTime', 'id', 'appName']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
})

export const currentRunSchema = z
  .object({
    runId: z.string(),
    id: z.string(),
    status: z.enum(['running', 'cancelling']),
    phase: z.string(),
    stepCount: z.number().int(),
    repairCount: z.number().int(),
    startedAt: utcDateTime,
    deadlineAt: utcDateTime,
  })
  .nullable()

export const appPreviewSchema = z.object({
  status: z.enum(['stopped', 'starting', 'running', 'failed', 'unavailable']),
  kind: z.enum(['static', 'vue', 'react']).nullable(),
  url: z.string().nullable(),
  lastError: z.string().nullable(),
})

export const appVoSchema = z.object({
  id: z.number().int(),
  appName: z.string(),
  initPrompt: z.string(),
  codeGenType: z.enum(['static', 'vue', 'react']).nullable(),
  userId: z.number().int(),
  status: z.string(),
  createTime: utcDateTime,
  updateTime: utcDateTime,
  currentRun: currentRunSchema,
  preview: appPreviewSchema,
})

export const appListPageSchema = z.object({
  records: z.array(appVoSchema),
  total: z.number().int(),
  current: z.number().int(),
  pageSize: z.number().int(),
  pages: z.number().int(),
})

export const addAppResultSchema = z.object({ id: z.number().int() })

export class AppIdDto extends createZodDto(appIdSchema) {}
export class AppIdBodyDto extends createZodDto(appIdBodySchema) {}
export class AddAppDto extends createZodDto(addAppSchema) {}
export class UpdateAppDto extends createZodDto(updateAppSchema) {}
export class ListAppQueryDto extends createZodDto(listAppQuerySchema) {}
export class AppVO extends createZodDto(appVoSchema) {}
export class AppListPageResult extends createZodDto(appListPageSchema) {}
export class AddAppResult extends createZodDto(addAppResultSchema) {}
export class BaseResponseAppVO extends createZodDto(envelope(appVoSchema)) {}
export class BaseResponseAppListPage extends createZodDto(envelope(appListPageSchema)) {}
export class BaseResponseAddApp extends createZodDto(envelope(addAppResultSchema)) {}
export class BaseResponseBoolean extends createZodDto(envelope(z.boolean())) {}
