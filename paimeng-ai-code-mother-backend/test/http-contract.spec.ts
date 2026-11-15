import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { ZodValidationException, ZodValidationPipe } from 'nestjs-zod'
import { describe, expect, it } from 'vitest'
import { AppIdDto } from '../src/apps/dto'
import { AppsController } from '../src/apps/apps.controller'
import { AuthController } from '../src/auth/auth.controller'
import { AppIdParamDto, ChatHistoryQueryDto } from '../src/conversations/dto'
import { GlobalExceptionFilter } from '../src/common/http'
import { PreviewController } from '../src/preview/preview.controller'
import { RunChangeDiffQueryDto, RunDetailsQueryDto, RunStatusQueryDto } from '../src/runs/dto'
import { RunsController } from '../src/runs/runs.controller'

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

  it('returns a null data field for validation errors', () => {
    const response = {
      headersSent: false,
      status(code: number) {
        expect(code).toBe(400)
        return this
      },
      json(body: unknown) {
        expect(body).toMatchObject({ code: 40000, message: expect.any(String), data: null })
      },
    }
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    }
    new GlobalExceptionFilter().catch(
      new ZodValidationException({ issues: [{ path: ['id'], message: '应用 ID 无效' }] }),
      host as never,
    )
  })

  it('returns 200 for every POST handler', () => {
    for (const controller of [AuthController, AppsController, RunsController, PreviewController]) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[method as keyof typeof controller.prototype]
        if (typeof handler !== 'function') continue
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler)
        if (requestMethod !== RequestMethod.POST) continue
        expect(
          Reflect.getMetadata(HTTP_CODE_METADATA, handler),
          `${controller.name}.${method} 的 POST 成功状态码必须是 200`,
        ).toBe(200)
      }
    }
  })
})
