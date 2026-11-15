import type { INestApplication } from '@nestjs/common'
import type { OpenAPIObject } from '@nestjs/swagger'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { cleanupOpenApiDoc } from 'nestjs-zod'
import { operationId } from '../common/openapi'

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = cleanupOpenApiDoc(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Paimeng API')
        .setDescription(
          '唯一 API 契约见 docs/DESIGN.md 的“接口契约”和 paimeng-ai-code-mother-backend/openapi.json',
        )
        .setVersion('1.0')
        .addServer('/api')
        .build(),
      { operationIdFactory: operationId, ignoreGlobalPrefix: true },
    ),
  )
  return normalizeNullable(document) as OpenAPIObject
}

type OpenApiNode = Record<string, unknown>

function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNullable)
  if (!node || typeof node !== 'object') return node
  const value = node as OpenApiNode
  if (value.nullable === true) {
    const { nullable: _nullable, ...rest } = value
    const base =
      Array.isArray(rest.enum) && rest.enum.includes(null)
        ? { ...rest, enum: rest.enum.filter((item) => item !== null) }
        : rest
    return { anyOf: [normalizeNullable(base), { type: 'null' }] }
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeNullable(child)]))
}
