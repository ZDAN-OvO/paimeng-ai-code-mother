import { BusinessError } from '../infra/http';

/** 槽位缺失或未启用的固定文案：管理端、运行期与语音降级都按它判断「没配」。 */
export function aliasNotConfiguredMessage(alias: string): string {
  return `模型别名 ${alias} 未配置或未启用`;
}

export function isAliasNotConfigured(error: unknown, alias: string): boolean {
  return error instanceof BusinessError && error.status === 503 && error.code === 50300 && error.message === aliasNotConfiguredMessage(alias);
}

/** 运行期配置无效，而不是暂时读不到 DB。这类错误不能被旧快照掩盖。 */
export class ModelConfigInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigInvalidError';
  }
}
