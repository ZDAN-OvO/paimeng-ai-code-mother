import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const healthSchema = z.object({
  status: z.string(),
  uptimeSeconds: z.number().int(),
})

export const readinessSchema = z.object({
  status: z.string(),
  checks: z.record(z.string(), z.string()),
})

export class HealthResult extends createZodDto(healthSchema) {}
export class ReadinessResult extends createZodDto(readinessSchema) {}
