import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope } from '../common/openapi'

export const healthSchema = z.object({
  status: z.string(),
  uptimeSeconds: z.number().int(),
})

export const readinessSchema = z.object({
  status: z.string(),
  checks: z.record(z.string(), z.string()),
})

export class BaseResponseHealth extends createZodDto(envelope(healthSchema)) {}
export class BaseResponseReadiness extends createZodDto(envelope(readinessSchema)) {}
