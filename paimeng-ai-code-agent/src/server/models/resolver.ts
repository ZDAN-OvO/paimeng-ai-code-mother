import 'server-only';
import { BusinessError } from '../infra/http';
import {
  missingSlotCapabilities,
  modelCapabilityLabels,
  modelSlotOf,
  type ModelAlias,
  type ModelAliasCapabilities,
  type ModelAliasSettings,
  type ModelProvider,
  type ModelSlot,
  type ProviderModel,
  type ProviderModelCompatibility,
} from '@/shared/model-config';
import { aliasNotConfiguredMessage } from './errors';

/**
 * 槽位的统一有效配置：提供商连接 + 提供商模型身份 + 槽位调用参数。
 * 调用方不再自己拼名称、猜能力或回查当前槽位；同一份快照只解析一次。
 *
 * 旧数据（`providerModelId` 为空）保留明确兼容分支：身份仍来自别名列，
 * 直到 P6 删除旧字符串写法。新数据的能力与兼容声明只认提供商模型。
 */
export type ResolvedSlot = {
  readonly alias: string;
  readonly slot: ModelSlot;
  readonly provider: ModelProvider;
  readonly providerModel: ProviderModel | null;
  readonly providerModelId: string | null;
  readonly providerId: string;
  /** 实际请求名：新数据来自模型，旧数据来自别名。 */
  readonly upstreamModelName: string;
  readonly capabilities: ModelAliasCapabilities;
  readonly settings: ModelAliasSettings;
  readonly compatibility: ProviderModelCompatibility;
  readonly legacy: boolean;
};

export type ModelSlotSnapshot = {
  readonly providers: readonly ModelProvider[];
  readonly providerModels: readonly ProviderModel[];
  readonly aliases: readonly ModelAlias[];
};

/** 槽位配置不可用（缺失、停用、引用断开或能力不满足）：语音等可选槽位据此降级。 */
export class SlotConfigUnavailableError extends BusinessError {
  constructor(message: string) {
    super(503, 50300, message);
    this.name = 'SlotConfigUnavailableError';
  }
}

function unavailable(message: string): BusinessError {
  return new SlotConfigUnavailableError(message);
}

/** 解析一个槽位；缺失、停用、引用断开或能力不满足都返回可读的 503/50300。 */
export function resolveSlotConfig(snapshot: ModelSlotSnapshot, aliasName: string): ResolvedSlot {
  const alias = snapshot.aliases.find(candidate => candidate.alias === aliasName);
  if (!alias || !alias.enabled) throw unavailable(aliasNotConfiguredMessage(aliasName));
  const slot = modelSlotOf(aliasName);
  if (!slot) throw unavailable(`模型别名 ${aliasName} 不是已知槽位`);

  const provider = snapshot.providers.find(candidate => candidate.id === alias.providerId);
  if (!provider || !provider.enabled) throw unavailable(aliasNotConfiguredMessage(aliasName));

  const providerModel = alias.providerModelId
    ? snapshot.providerModels.find(candidate => candidate.id === alias.providerModelId) ?? null
    : null;
  if (alias.providerModelId && !providerModel) {
    throw unavailable(`别名 ${aliasName} 引用的提供商模型 ${alias.providerModelId} 不存在`);
  }
  if (providerModel) {
    if (providerModel.providerId !== provider.id) throw unavailable(`别名 ${aliasName} 与提供商模型 ${providerModel.id} 不属于同一提供商`);
    if (!providerModel.enabled) throw unavailable(`提供商模型 ${providerModel.id} 已停用，别名 ${aliasName} 不可用`);
  }

  const capabilities = providerModel?.capabilities ?? alias.capabilities;
  const missing = missingSlotCapabilities(slot, capabilities);
  if (missing.length) {
    const labels = missing.map(requirement => modelCapabilityLabels[requirement]).join('、');
    throw unavailable(`槽位 ${aliasName} 需要${labels}能力，当前提供商模型不满足`);
  }

  const compatibility = providerModel?.compatibility ?? { reasoningContentPassthrough: alias.settings.reasoningContentPassthrough ?? false };
  return Object.freeze({
    alias: alias.alias,
    slot,
    provider: Object.freeze({ ...provider, options: Object.freeze({ ...provider.options }), headers: Object.freeze({ ...(provider.headers ?? {}) }) }),
    providerModel: providerModel
      ? Object.freeze({ ...providerModel, capabilities: Object.freeze({ ...providerModel.capabilities }), compatibility: Object.freeze({ ...providerModel.compatibility }) })
      : null,
    providerModelId: providerModel?.id ?? null,
    providerId: provider.id,
    upstreamModelName: providerModel?.upstreamModelName ?? alias.modelName,
    capabilities: Object.freeze({ ...capabilities }),
    settings: Object.freeze({ ...alias.settings }),
    compatibility: Object.freeze({ ...compatibility }),
    legacy: providerModel === null,
  });
}
