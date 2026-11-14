import { existsSync } from 'node:fs'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { cleanupOpenApiDoc } from 'nestjs-zod'
import type { Request, Response, NextFunction } from 'express'
import { AppModule } from './app.module'
import { AppConfigService } from './config/config.module'
import { SessionService } from './auth/session.service'
import { PreviewService } from './preview/preview.service'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
} else if (existsSync('../.env')) {
  process.loadEnvFile('../.env')
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false })
  const config = app.get(AppConfigService)
  const preview = app.get(PreviewService)
  const session = app.get(SessionService)

  app.setGlobalPrefix('api')
  app.enableShutdownHooks()
  const express = app.getHttpAdapter().getInstance()
  express.disable('x-powered-by')
  express.set('etag', false)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/api')) {
      // 历史、应用详情等 GET 不能被浏览器缓存；304 空响应会被前端误判为加载失败。
      delete req.headers['if-none-match']
      delete req.headers['if-modified-since']
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
    next()
  })

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const appId = preview.parsePreviewHost(req.headers.host)
    if (appId !== null) {
      void preview.handleHttp(req, _res, appId, req.originalUrl)
      return
    }
    ;(req as Request & { cookies?: Record<string, string> }).cookies = parseCookies(req.headers.cookie)
    next()
  })
  app.use(session.middleware())

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('派蒙 AI 代码生成平台 API')
      .setDescription('唯一 API 契约见 docs/api.md')
      .setVersion('1.0')
      .build(),
  ))
  SwaggerModule.setup('api/v3/api-docs', app, document)

  await app.listen(config.port, '127.0.0.1')
  const server = app.getHttpServer()
  server.on('upgrade', (req: Request, socket: never, head: Buffer) => preview.handleUpgrade(req, socket, head))

  Logger.log(`后端已启动 http://127.0.0.1:${config.port}/api`, 'Bootstrap')
}

void bootstrap()
