import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const chatSchema = z.object({
  appId: z.number().int().positive(),
  message: z.string().trim().min(1).max(1000),
  clientRequestId: z.string().trim().min(8).max(100),
})

export const cancelSchema = z.object({
  runId: z.string().uuid(),
})

export class ChatDto extends createZodDto(chatSchema) {}
export class CancelDto extends createZodDto(cancelSchema) {}
