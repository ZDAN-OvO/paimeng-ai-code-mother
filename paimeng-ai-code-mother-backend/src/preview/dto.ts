import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope } from '../common/openapi'

export const appIdBodySchema = z.object({ appId: z.number().int().positive('应用 ID 无效') })

export const previewStatusQuerySchema = z.object({
  appId: z.coerce.number().int().positive('应用 ID 无效'),
})

const previewStatusSchema = z.enum(['stopped', 'starting', 'running', 'failed'])

export const previewStartSchema = z.object({
  status: previewStatusSchema,
  error: z.string().nullable(),
  url: z.string().nullable(),
})

export const previewStatusSchemaValue = z.object({
  status: previewStatusSchema,
  kind: z.enum(['static', 'vue', 'react']).nullable(),
  url: z.string().nullable(),
  lastError: z.string().nullable(),
})

export const previewAccessSchema = z.object({
  ticket: z.object({ ticket: z.string(), expiresIn: z.number().int() }),
  url: z.string(),
  expiresInSeconds: z.number().int(),
})

export class AppIdDto extends createZodDto(appIdBodySchema) {}
export class PreviewStatusQueryDto extends createZodDto(previewStatusQuerySchema) {}
export class PreviewStartResult extends createZodDto(previewStartSchema) {}
export class PreviewStatus extends createZodDto(previewStatusSchemaValue) {}
export class PreviewAccess extends createZodDto(previewAccessSchema) {}
export class BaseResponsePreviewStart extends createZodDto(envelope(previewStartSchema)) {}
export class BaseResponsePreviewStatus extends createZodDto(envelope(previewStatusSchemaValue)) {}
export class BaseResponsePreviewAccess extends createZodDto(envelope(previewAccessSchema)) {}
export class BaseResponseBoolean extends createZodDto(envelope(z.boolean())) {}
