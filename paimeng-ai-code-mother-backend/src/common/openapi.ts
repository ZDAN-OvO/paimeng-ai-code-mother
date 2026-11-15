import { z } from 'zod'

export const utcDateTime = z.string().datetime({ offset: true })

export const apiCodeSchema = z.number().int()
export const apiMessageSchema = z.string()

export function envelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    code: apiCodeSchema,
    message: apiMessageSchema,
    data,
  })
}

export const operationId = (_controller: unknown, method: string) => method
