import { describe, expect, it } from 'vitest';
import type { ModelAlias, ModelProvider, ProviderModel } from '@/shared/model-config';
import { resolveSlotConfig } from '@/server/models/resolver';

const capabilities = { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false };

const provider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'primary',
  displayName: '主提供商',
  apiFormat: 'openai-chat',
  baseUrl: 'https://primary.example.test/v1',
  apiKeySource: 'env',
  apiKeyEnv: 'AI_API_KEY',
  options: {},
  headers: {},
  enabled: true,
  createTime: '',
  updateTime: '',
  ...overrides,
}) as ModelProvider;

const model = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: '7001',
  providerId: 'primary',
  upstreamModelName: 'model-upstream',
  displayName: '主提供商 / model-upstream',
  capabilities,
  compatibility: { reasoningContentPassthrough: false },
  enabled: true,
  createTime: '',
  updateTime: '',
  ...overrides,
});

const alias = (overrides: Partial<ModelAlias> = {}): ModelAlias => ({
  alias: 'codegen.default',
  providerModelId: '7001',
  providerId: 'primary',
  modelName: 'model-upstream',
  capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: true },
  settings: { temperature: 0.3, reasoning: 'high' },
  enabled: true,
  createTime: '',
  updateTime: '',
  ...overrides,
});

describe('槽位统一解析', () => {
  it('新数据的能力、兼容声明与实际请求名都来自提供商模型，采样参数仍来自槽位', () => {
    const resolved = resolveSlotConfig({
      providers: [provider()],
      providerModels: [model({ compatibility: { reasoningContentPassthrough: true } })],
      aliases: [alias({ settings: { temperature: 0.3, reasoning: 'high', reasoningContentPassthrough: false } })],
    }, 'codegen.default');
    expect(resolved).toMatchObject({
      alias: 'codegen.default',
      providerId: 'primary',
      providerModelId: '7001',
      upstreamModelName: 'model-upstream',
      capabilities,
      settings: { temperature: 0.3, reasoning: 'high' },
      compatibility: { reasoningContentPassthrough: true },
      legacy: false,
    });
    expect(resolved.provider.id).toBe('primary');
    expect(resolved.providerModel?.id).toBe('7001');
  });

  it('两个槽位共用同一模型时共享能力，采样与思考参数各自独立', () => {
    const shared = model({ capabilities: { streaming: true, toolCalling: true, structuredOutput: true, imageInput: false } });
    const snapshot = {
      providers: [provider()],
      providerModels: [shared],
      aliases: [
        alias({ settings: { temperature: 0.2, reasoning: 'low' } }),
        alias({ alias: 'route.classify', settings: { temperature: 0.8, reasoning: 'max' } }),
      ],
    };
    const codegen = resolveSlotConfig(snapshot, 'codegen.default');
    const route = resolveSlotConfig(snapshot, 'route.classify');
    expect(codegen.capabilities).toEqual(shared.capabilities);
    expect(route.capabilities).toEqual(shared.capabilities);
    expect(codegen.settings).toEqual({ temperature: 0.2, reasoning: 'low' });
    expect(route.settings).toEqual({ temperature: 0.8, reasoning: 'max' });
  });

  it('旧数据没有模型 ID 时回退到别名投影，并标出兼容分支', () => {
    const resolved = resolveSlotConfig({
      providers: [provider()],
      providerModels: [],
      aliases: [alias({
        providerModelId: null,
        modelName: 'legacy-model',
        capabilities,
        settings: { reasoningContentPassthrough: true },
      })],
    }, 'codegen.default');
    expect(resolved).toMatchObject({
      providerModelId: null,
      upstreamModelName: 'legacy-model',
      capabilities,
      compatibility: { reasoningContentPassthrough: true },
      legacy: true,
    });
  });

  it('缺失、停用或引用断开的槽位给出可读的 503', () => {
    const base = { providers: [provider()], providerModels: [model()], aliases: [alias()] };
    expect(() => resolveSlotConfig({ ...base, aliases: [] }, 'codegen.default')).toThrow(/未配置或未启用/);
    expect(() => resolveSlotConfig({ ...base, aliases: [alias({ enabled: false })] }, 'codegen.default')).toThrow(/未配置或未启用/);
    expect(() => resolveSlotConfig({ ...base, providers: [provider({ enabled: false })] }, 'codegen.default')).toThrow(/未配置或未启用/);
    expect(() => resolveSlotConfig({ ...base, providerModels: [] }, 'codegen.default')).toThrow(/引用的提供商模型 7001 不存在/);
    expect(() => resolveSlotConfig({ ...base, providerModels: [model({ enabled: false })] }, 'codegen.default')).toThrow(/已停用/);
    expect(() => resolveSlotConfig({ ...base, providerModels: [model({ providerId: 'other' })] }, 'codegen.default')).toThrow(/不属于同一提供商/);
  });

  it('必需能力按模型能力校验，不满足时不放行', () => {
    expect(() => resolveSlotConfig({
      providers: [provider()],
      providerModels: [model({ capabilities: { ...capabilities, toolCalling: false } })],
      aliases: [alias({ capabilities })],
    }, 'codegen.default')).toThrow(/工具调用/);
  });

  it('可选槽位不要求能力，仍能解析', () => {
    const resolved = resolveSlotConfig({
      providers: [provider()],
      providerModels: [model({ capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false } })],
      aliases: [alias({
        alias: 'speech.transcribe',
        providerModelId: null,
        modelName: 'whisper',
        capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false },
        settings: {},
      })],
    }, 'speech.transcribe');
    expect(resolved.upstreamModelName).toBe('whisper');
    expect(resolved.legacy).toBe(true);
  });
});
