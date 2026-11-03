import 'server-only';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import {
  allowedModelApiKeyEnvs,
  isAllowedModelApiKeyEnv,
  modelBaseUrlIssue,
  modelAdminConfigSchema,
  modelConfigApplySchema,
  modelProviderFormatViews,
  modelProviderProbeSchema,
  modelSlots,
  modelProviderWriteSchema,
  type ModelConfigPolicy,
  type ModelConfigVersion,
  type ModelProviderWriteInput,
  type ProviderModelsView,
} from '@/shared/model-config';
import {
  currentPriceOf,
  modelConfigMutatePayloadSchema,
  type ModelAdminConfigView,
  type ModelAdminModelView,
  type ModelAdminProviderView,
} from '@/shared/model-document';
import type { ModelConfigProvider } from '@/shared/model-document';
import { modelRegistry } from './registry';
import { fetchProviderModels } from './probe';
import { decryptModelSecret } from './secrets';
import { applyModelConfig, mutateModelConfig, readModelConfigDocumentState } from './store';

/**
 * 管理 API 的服务层：读取一份 JSON 文档视图，或执行一次带 expectedRevision 的变更。
 * 每个入口都要求调用者已完成管理员鉴权；本模块不处理 HTTP，也不回显密钥值。
 */

function unavailable(): BusinessError {
  return new BusinessError(503, 50300, '模型配置暂时不可用，请稍后重试');
}

async function storageGuarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    console.error(
      'Model config storage failure:',
      error instanceof Error ? error.name : typeof error,
    );
    throw unavailable();
  }
}

function providerView(providerState: ModelConfigProvider): ModelAdminProviderView {
  const models: ModelAdminModelView[] = providerState.models.map((model) => ({
    id: model.id,
    providerId: providerState.id,
    upstream: model.upstream,
    displayName: model.displayName,
    enabled: model.enabled,
    capabilities: model.capabilities,
    upstreamPrice: model.upstreamPrice,
    prices: model.prices,
    currentPrice: currentPriceOf(model),
    createTime: model.createTime,
    updateTime: model.updateTime,
  }));
  const common = {
    id: providerState.id,
    displayName: providerState.displayName,
    apiFormat: providerState.apiFormat,
    baseUrl: providerState.baseUrl,
    options: providerState.options,
    headers: providerState.headers,
    enabled: providerState.enabled,
    createTime: providerState.createTime,
    updateTime: providerState.updateTime,
    apiKeyConfigured:
      providerState.apiKey.source === 'inline' || Boolean(process.env[providerState.apiKey.env]),
    models,
  };
  return providerState.apiKey.source === 'env'
    ? { ...common, apiKeySource: 'env' as const, apiKeyEnv: providerState.apiKey.env }
    : { ...common, apiKeySource: 'inline' as const };
}

export async function readModelAdminConfig(raw: unknown): Promise<ModelAdminConfigView> {
  modelAdminConfigSchema.parse(raw);
  const config = getConfig();
  const state = await storageGuarded(() => readModelConfigDocumentState());
  return {
    revision: state.revision,
    refreshEpoch: state.refreshEpoch,
    initialized: state.document.providers.length > 0 || state.document.slots.length > 0,
    documentBytes: Buffer.byteLength(JSON.stringify(state.document), 'utf8'),
    providers: state.document.providers.map(providerView),
    assignments: state.document.slots,
    slotDefinitions: modelSlots.map((slot) => ({ ...slot, requires: [...slot.requires] })),
    providerFormats: [...modelProviderFormatViews],
    allowedApiKeyEnvs: [...allowedModelApiKeyEnvs(config.modelApiKeyEnvAllowlist)],
    instance: modelRegistry().status(),
  };
}

export async function mutateModelConfigAdmin(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelConfigMutatePayloadSchema.parse(raw);
  return storageGuarded(() => mutateModelConfig(payload));
}

export async function applyModelConfigNow(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelConfigApplySchema.parse(raw);
  return storageGuarded(() => applyModelConfig({ expectedRevision: payload.expectedRevision }));
}

/**
 * 探测用密钥：inline 且表单留空时沿用库里已保存的密文，env 必须命中部署允许名单。
 * 参数错误抛 400；错误信息只出现环境变量名，绝不回显密钥值。
 */
async function probeApiKey(
  provider: ModelProviderWriteInput,
  policy: ModelConfigPolicy,
): Promise<string> {
  if (provider.apiKeySource === 'env') {
    if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, policy.allowedApiKeyEnvs)) {
      throw new BusinessError(400, 40000, `引用了未允许的环境变量 ${provider.apiKeyEnv}`);
    }
    const value = process.env[provider.apiKeyEnv];
    if (!value)
      throw new BusinessError(
        400,
        40000,
        `环境变量 ${provider.apiKeyEnv} 没有值，请先在部署环境配置`,
      );
    return value;
  }
  const submitted = provider.apiKey.trim();
  if (submitted) return submitted;
  const state = await readModelConfigDocumentState();
  const stored = state.document.providers.find((candidate) => candidate.id === provider.id);
  if (!stored || stored.apiKey.source !== 'inline') {
    throw new BusinessError(400, 40000, '请填写直接输入的密钥');
  }
  try {
    return decryptModelSecret(stored.apiKey.ciphertext);
  } catch (error) {
    throw new BusinessError(
      400,
      40000,
      error instanceof Error ? error.message : '已保存的密钥无法解密，请重新保存',
    );
  }
}

export async function probeProviderModels(raw: unknown): Promise<ProviderModelsView> {
  const payload = modelProviderProbeSchema.parse(raw);
  const config = getConfig();
  return storageGuarded(async () => {
    const policy: ModelConfigPolicy = {
      allowedApiKeyEnvs: allowedModelApiKeyEnvs(config.modelApiKeyEnvAllowlist),
      internalOrigins: config.modelInternalBaseUrlOrigins,
    };
    const provider = modelProviderWriteSchema.parse(payload.provider);
    const urlIssue = modelBaseUrlIssue(provider.baseUrl, policy);
    if (urlIssue) throw new BusinessError(400, 40000, `模型地址不合法：${urlIssue}`);
    const apiKey = await probeApiKey(provider, policy);
    return {
      models: await fetchProviderModels(
        {
          apiFormat: provider.apiFormat,
          baseUrl: provider.baseUrl,
          headers: provider.headers ?? {},
        },
        apiKey,
      ),
    };
  });
}
