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
          '字段契约见本页导出的 OpenAPI 文档；公共约定见仓库根 AGENTS.md，模块行为见 ARCHITECTURE.md',
        )
        .setVersion('1.0')
        .addServer('/api')
        .addCookieAuth('pm_sid')
        .addSecurityRequirements('cookie')
        .build(),
      { operationIdFactory: operationId, ignoreGlobalPrefix: true },
    ),
  )
  return normalizeDocument(document) as unknown as OpenAPIObject
}

type OpenApiNode = Record<string, unknown>

function normalizeDocument(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeDocument)
  if (!node || typeof node !== 'object') return node
  const value = node as OpenApiNode
  if (value.exclusiveMinimum === true && typeof value.minimum === 'number') {
    const { minimum, ...rest } = value
    return { ...rest, exclusiveMinimum: minimum }
  }
  if (value.nullable === true) {
    const { nullable: _nullable, ...rest } = value
    const base =
      Array.isArray(rest.enum) && rest.enum.includes(null)
        ? { ...rest, enum: rest.enum.filter((item) => item !== null) }
        : rest
    return { anyOf: [normalizeDocument(base), { type: 'null' }] }
  }
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeDocument(child)]),
  )
  if ('openapi' in normalized) normalized.openapi = '3.1.0'
  return normalized
}
