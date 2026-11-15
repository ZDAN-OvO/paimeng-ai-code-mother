import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import type { OpenAPIObject } from '@nestjs/swagger'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { buildOpenApiDocument } from '../src/openapi/document'

const ENV_KEYS = [
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_CONTEXT_WINDOW_TOKENS',
]
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

let app: INestApplication
let document: OpenAPIObject

const rawPaths = new Set(['/app/chat/gen/code', '/health', '/health/ready'])

beforeAll(async () => {
  process.env.SESSION_SECRET = 'x'.repeat(32)
  process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/test'
  process.env.REDIS_URL = 'redis://127.0.0.1:6379'
  process.env.AI_BASE_URL = 'http://127.0.0.1:3425/v1'
  process.env.AI_MODEL = 'test-model'
  process.env.AI_CONTEXT_WINDOW_TOKENS = '10000'
  app = await NestFactory.create(AppModule, { preview: true, logger: false })
  app.setGlobalPrefix('api')
  document = buildOpenApiDocument(app)
})

afterAll(async () => {
  await app?.close()
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function operations() {
  const result: Array<{ path: string; operation: Record<string, unknown> }> = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const operation of Object.values(item ?? {})) {
      if (operation && typeof operation === 'object' && 'responses' in operation) {
        result.push({ path, operation: operation as Record<string, unknown> })
      }
    }
  }
  return result
}

describe('OpenAPI contract', () => {
  it('documents every route', () => {
    expect(Object.keys(document.paths ?? {})).toHaveLength(25)
  })

  it('declares the OpenAPI version used by the contract', () => {
    expect(document.openapi).toBe('3.1.0')
  })

  it('declares a named envelope for every JSON endpoint', () => {
    for (const { path, operation } of operations()) {
      if (rawPaths.has(path)) continue
      const responses = operation.responses as Record<
        string,
        { content?: Record<string, { schema?: { $ref?: string } }> }
      >
      const schema = responses['200']?.content?.['application/json']?.schema
      expect(schema?.$ref, `${path} 缺少命名响应 schema`).toMatch(/^#\/components\/schemas\/BaseResponse/)
    }
  })

  it('gives every query and path parameter an explicit schema', () => {
    for (const { path, operation } of operations()) {
      const parameters = (operation.parameters ?? []) as Array<{ name: string; schema?: unknown }>
      for (const parameter of parameters) {
        expect(parameter.schema, `${path} 的参数 ${parameter.name} 没有 schema`).toBeTruthy()
      }
    }
  })

  it('uses unique operation ids', () => {
    const ids = operations().map(({ operation }) => operation.operationId as string)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('userLogin')
    expect(ids).toContain('listMyAppVoByPage')
  })

  it('exposes message and stream chunk models', () => {
    const schemas = document.components?.schemas ?? {}
    for (const name of ['ChatUIMessage', 'UIMessagePart', 'RunStartedChunk', 'PhaseChunk', 'RunChunk']) {
      expect(Object.keys(schemas), `缺少 ${name}`).toContain(name)
    }
  })

  it('keeps nullable enums strict instead of falling back to any', () => {
    const serialized = JSON.stringify(document)
    expect(serialized).toContain(
      '"anyOf":[{"type":"string","enum":["static","vue","react"]},{"type":"null"}]',
    )
    expect(serialized).not.toContain('"nullable":true')
  })
})
