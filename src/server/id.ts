import { randomBytes, randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

/** 发布地址里的不可猜测标识，12 个 URL 安全字符。 */
export function newDeployKey(): string {
  return randomBytes(9).toString('base64url');
}
