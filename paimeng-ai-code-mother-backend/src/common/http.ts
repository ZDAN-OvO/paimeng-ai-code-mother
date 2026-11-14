import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  SetMetadata,
  CanActivate,
  createParamDecorator,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppConfigService } from '../config/config.module'
import { ZodValidationException } from 'nestjs-zod'
import type { Request, Response } from 'express'
import { Observable, map } from 'rxjs'
import { ApiEnvelope, ApiException, API_CODES, ok } from './api'

export const IS_PUBLIC = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC, true)

export const RAW_RESPONSE = 'rawResponse'
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true)

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): number => {
  const req = ctx.switchToHttp().getRequest<Request>()
  const userId = req.session?.userId
  if (!userId) throw ApiException.unauthorized()
  return userId
})

export const CurrentSessionId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>()
  return req.sessionID
})

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    let code: number = API_CODES.INTERNAL
    let status = 500
    let message = '服务器内部错误'
    let details: unknown

    if (exception instanceof ApiException) {
      code = exception.code
      status = exception.status
      message = exception.message
      details = exception.details
    } else if (exception instanceof ZodValidationException) {
      code = API_CODES.BAD_REQUEST
      status = 400
      const issues = (exception.getZodError() as { issues?: { path?: (string | number)[]; message?: string }[] })
        .issues ?? []
      message =
        issues.map((i) => `${(i.path ?? []).join('.') || 'body'}: ${i.message ?? '格式不正确'}`).join('; ') ||
        '请求参数格式不正确'
      details = issues
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      code = status === 404 ? API_CODES.NOT_FOUND : status === 403 ? API_CODES.FORBIDDEN : API_CODES.BAD_REQUEST
      const body = exception.getResponse()
      message =
        typeof body === 'string'
          ? body
          : typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : exception.message
    } else {
      const err = exception instanceof Error ? exception : new Error(String(exception))
      console.error('[unhandled]', err.stack ?? err.message)
    }

    const body: ApiEnvelope<unknown> = { code, message, data: details ?? null }
    res.status(status).json(body)
  }
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ])
    if (raw) return next.handle()
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'code' in data && 'message' in data && 'data' in data) {
          return data
        }
        return ok(data ?? null)
      }),
    )
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true
    const req = context.switchToHttp().getRequest<Request>()
    if (!req.session?.userId) throw ApiException.unauthorized()
    return true
  }
}

/**
 * 所有修改请求必须来自主站 Origin。预览来源、空 Origin 的浏览器写操作一律拒绝。
 * GET/HEAD/OPTIONS 不校验，以免影响同源页面加载。
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>()
    const method = req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
    const origin = req.headers.origin
    if (!origin) {
      // 非浏览器客户端（curl、健康检查、测试）不带 Origin，允许通过；浏览器跨站写请求一定带 Origin。
      return true
    }
    const normalized = origin.replace(/\/$/, '')
    if (!this.config.allowedOrigins.includes(normalized)) {
      throw ApiException.forbidden('请求来源不被允许')
    }
    return true
  }
}

export function isMainOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false
  return allowedOrigins.includes(origin.replace(/\/$/, ''))
}
