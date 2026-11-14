import 'reflect-metadata'
import { APP_PIPE } from '@nestjs/core'
import { ZodValidationPipe } from 'nestjs-zod'
import { describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { ChatDto } from '../src/runs/dto'

describe('HTTP DTO validation', () => {
  it('registers the zod validation pipe globally', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: unknown
      useClass?: unknown
    }>
    expect(providers).toContainEqual({ provide: APP_PIPE, useClass: ZodValidationPipe })
  })

  it('rejects invalid chat boundaries before the controller runs', () => {
    const pipe = new ZodValidationPipe()
    expect(() =>
      pipe.transform(
        { appId: -1, message: 'x'.repeat(1001), clientRequestId: 'short' },
        { type: 'body', metatype: ChatDto, data: undefined },
      ),
    ).toThrow()
  })
})
