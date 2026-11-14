export const API_CODES = {
  OK: 0,
  BAD_REQUEST: 40000,
  UNAUTHORIZED: 40100,
  FORBIDDEN: 40300,
  NOT_FOUND: 40400,
  CONFLICT: 40900,
  RATE_LIMITED: 42900,
  INTERNAL: 50000,
  SERVICE_UNAVAILABLE: 50300,
} as const

export const RUN_ERROR_CODES = {
  MODEL_OUTPUT_LIMIT: 'MODEL_OUTPUT_LIMIT',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
} as const

export class ApiException extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
  }

  static badRequest(message: string, code = API_CODES.BAD_REQUEST) {
    return new ApiException(code, message, 400)
  }
  static unauthorized(message = '未登录') {
    return new ApiException(API_CODES.UNAUTHORIZED, message, 401)
  }
  static forbidden(message = '无权访问') {
    return new ApiException(API_CODES.FORBIDDEN, message, 403)
  }
  static notFound(message = '资源不存在') {
    return new ApiException(API_CODES.NOT_FOUND, message, 404)
  }
  static conflict(message: string, code = API_CODES.CONFLICT) {
    return new ApiException(code, message, 409)
  }
  static rateLimited(message: string) {
    return new ApiException(API_CODES.RATE_LIMITED, message, 429)
  }
  static unavailable(message: string) {
    return new ApiException(API_CODES.SERVICE_UNAVAILABLE, message, 503)
  }
  static internal(message = '服务器内部错误') {
    return new ApiException(API_CODES.INTERNAL, message, 500)
  }
}

export interface ApiEnvelope<T> {
  code: number
  message: string
  data: T | null
}

export function ok<T>(data: T): ApiEnvelope<T> {
  return { code: API_CODES.OK, message: 'ok', data }
}

export function page<T>(records: T[], total: number, current: number, pageSize: number) {
  return { records, total, current, pageSize, pages: Math.ceil(total / pageSize) || 0 }
}
