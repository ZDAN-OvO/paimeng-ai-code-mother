import { describe, expect, it } from 'vitest'
import {
  chatSchema,
  enqueueMessageSchema,
  messageQueueQuerySchema,
  runStatusQuerySchema,
} from '../src/runs/dto'

const input = { appId: 1, message: '继续实现页面' }
const contracts = [
  { name: '聊天发送', parse: (id: string) => chatSchema.safeParse({ ...input, clientRequestId: id }) },
  {
    name: '消息入队',
    parse: (id: string) => enqueueMessageSchema.safeParse({ ...input, clientRequestId: id, mode: 'normal' }),
  },
  {
    name: '运行查询',
    parse: (id: string) => runStatusQuerySchema.safeParse({ appId: 1, clientRequestId: id }),
  },
  {
    name: '队列消息查询',
    parse: (id: string) => messageQueueQuerySchema.safeParse({ appId: 1, clientRequestId: id }),
  },
]

describe.each(contracts)('$name 请求 ID', ({ parse }) => {
  it.each([8, 64])('接受 %i 个字符并去除首尾空白', (length) => {
    const clientRequestId = 'a'.repeat(length)
    const result = parse(` ${clientRequestId} `)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.clientRequestId).toBe(clientRequestId)
  })

  it.each([7, 65, 100])('拒绝 %i 个字符并提示一致边界', (length) => {
    const result = parse('a'.repeat(length))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('clientRequestId 长度需在 8-64 之间')
    }
  })
})

it('按 runId 查询时无需 clientRequestId', () => {
  expect(runStatusQuerySchema.safeParse({ runId: '00000000-0000-4000-8000-000000000000' }).success).toBe(true)
})
