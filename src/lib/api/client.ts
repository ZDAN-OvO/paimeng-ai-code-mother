import type { ZodType } from 'zod';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit, schema?: ZodType<T>): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiRequestError(response.status, '响应不是合法 JSON');
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new ApiRequestError(response.status, message);
  }
  return schema ? schema.parse(data) : (data as T);
}

export const api = {
  get: <T>(path: string, schema?: ZodType<T>, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'GET' }, schema),
  post: <T>(path: string, body?: unknown, schema?: ZodType<T>) =>
    request<T>(
      path,
      {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      schema,
    ),
  patch: <T>(path: string, body: unknown, schema?: ZodType<T>) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, schema),
  put: <T>(path: string, body: unknown, schema?: ZodType<T>) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }, schema),
  delete: <T>(path: string, schema?: ZodType<T>) => request<T>(path, { method: 'DELETE' }, schema),
};

/** SSE 增量解析：按空行切分事件，支持注释心跳、跨分片和多行 data。 */
export function createSseParser<T>(onEvent: (event: T) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.trim()) onEvent(JSON.parse(data) as T);
      boundary = buffer.indexOf('\n\n');
    }
  };
}

/** 逐条读取 `data: <json>` 事件；流结束或调用方 abort 时返回。 */
export async function streamEvents<T>(
  path: string,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok || !response.body) {
    throw new ApiRequestError(response.status, '无法订阅事件流');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const feed = createSseParser(onEvent);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
