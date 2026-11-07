import type { z } from 'zod';
import { ApiError } from './world';

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, `请求体不合法（${detail}）`);
  }
  return result.data;
}

/** 把 ApiError 转成带状态码的 JSON，其余异常记日志后返回 500。 */
export function withErrors<Args extends unknown[]>(
  handler: (...args: Args) => Response | Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      console.error('[api]', error);
      return Response.json({ error: '服务端未预期错误' }, { status: 500 });
    }
  };
}
