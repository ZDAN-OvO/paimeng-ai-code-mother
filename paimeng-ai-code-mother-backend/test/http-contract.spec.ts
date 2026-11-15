import 'reflect-metadata'
import { ZodValidationException, ZodValidationPipe } from 'nestjs-zod'
import { describe, expect, it } from 'vitest'
import { AppIdDto } from '../src/apps/dto'
import { AppIdParamDto, ChatHistoryQueryDto } from '../src/conversations/dto'
import { RunChangeDiffQueryDto, RunDetailsQueryDto, RunStatusQueryDto } from '../src/runs/dto'

const pipe = new ZodValidationPipe()

function validate(value: Record<string, unknown>, metatype: new () => unknown) {
  try {
    pipe.transform(value, { type: 'query', metatype, data: undefined })
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(ZodValidationException)
    const issues = (error as ZodValidationException).getZodError() as {
      issues: Array<{ path: Array<string | number>; message: string }>
    }
    return issues.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  }
}

describe('HTTP contract validation', () => {
  it('rejects an invalid application id', () => {
    expect(validate({ id: 'abc' }, AppIdDto)).toContain('应用 ID 无效')
  })

  it('rejects an invalid run id', () => {
    expect(validate({ runId: 'not-a-uuid' }, RunDetailsQueryDto)).toContain('runId 格式无效')
  })

  it('rejects a non-positive page size', () => {
    expect(validate({ appId: '1', pageSize: '0' }, ChatHistoryQueryDto)).not.toBeNull()
  })

  it('rejects an invalid application path parameter', () => {
    expect(validate({ appId: '0' }, AppIdParamDto)).toContain('应用 ID 无效')
  })

  it('rejects an invalid file id', () => {
    expect(
      validate({ runId: '7f9c2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b', fileId: 'x' }, RunChangeDiffQueryDto),
    ).not.toBeNull()
  })

  it('accepts a run status query by run id or by request id', () => {
    expect(validate({ runId: '7f9c2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b' }, RunStatusQueryDto)).toBeNull()
    expect(validate({ appId: '3', clientRequestId: 'client-req-1' }, RunStatusQueryDto)).toBeNull()
  })
})
