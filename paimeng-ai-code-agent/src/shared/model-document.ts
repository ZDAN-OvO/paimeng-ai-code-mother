import { z } from 'zod';
import {
  aliasCapabilitiesSchema,
  aliasSettingsSchema,
  isAllowedModelApiKeyEnv,
  missingSlotCapabilities,
  modelApiKeyCiphertextSchema,
  modelApiKeyEnvSchema,
  modelBaseUrlIssue,
  modelCapabilityLabels,
  modelProviderIdSchema,
  modelProviderInputSchema,
  modelSlotOf,
  modelSlots,
  providerApiFormats,
  providerHeadersSchema,
  providerOptionKeysByFormat,
  providerOptionsIssue,
  providerOptionsSchema,
  requiredModelAliases,
  type ModelAlias,
  type ModelConfigPolicy,
  type ModelConfigSnapshot,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderView,
  type ProviderApiFormat,
} from './model-config';

/**
 * 模型配置文档：PostgreSQL 只承载一行 `app_config.value`，提供商、模型、价格版本与槽位分配
 * 全部收在这份 JSON 里。这里只放 shared 类型与纯函数，读写和加密留在服务端。
 */

export const modelConfigKey = 'model_config';
export const modelConfigSchemaVersion = 1;

const naiveTimestamp = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u, '生效时间必须形如 2026-10-01 00:00:00.000（UTC）')
  .refine(value => !Number.isNaN(Date.parse(`${value.replace(' ', 'T')}Z`)), '生效时间不是合法时刻');

const optionalUsd = z
  .union([z.null(), z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/u, '上游成本是 USD / 1M tokens，最多 6 位小数')])
  .optional()
  .transform(value => value ?? null);

const usdReferenceSchema = z.strictObject({
  inputMiss: optionalUsd,
  inputHit: optionalUsd,
  output: optionalUsd,
});

export type UsdReference = z.infer<typeof usdReferenceSchema>;

const cnyFen = z.number().int('单价必须是整数分').min(0, '单价不能是负数').max(Number.MAX_SAFE_INTEGER, '单价超出范围');

export const modelPriceVersionSchema = z
  .strictObject({
    version: z.number().int().min(1),
    effectiveAt: naiveTimestamp,
    currency: z.literal('CNY'),
    /** 单位是「分 / 1M tokens」；界面显示为 `fen / 100` 元。 */
    inputMissFen: cnyFen,
    inputHitFen: cnyFen,
    outputFen: cnyFen,
    upstreamUsd: usdReferenceSchema.nullish().transform(value => value ?? null),
    note: z.string().max(2000).nullish().transform(value => value ?? null),
  })
  .refine(value => value.inputMissFen > 0 || value.inputHitFen > 0 || value.outputFen > 0, '三个单价不能同时为 0');

export type ModelPriceVersion = z.infer<typeof modelPriceVersionSchema>;

export const modelUpstreamPriceSchema = z.strictObject({
  currency: z.literal('USD'),
  inputMiss: optionalUsd,
  inputHit: optionalUsd,
  output: optionalUsd,
});

export type ModelUpstreamPrice = z.infer<typeof modelUpstreamPriceSchema>;

export const providerModelSchema = z.strictObject({
  id: z.string().min(1).max(64).regex(/^pm_[a-z0-9]+$/, '模型标识必须形如 pm_...'),
  upstream: z.string().trim().min(1, '上游模型名不能为空').max(256),
  displayName: z.string().trim().min(1, '模型名称不能为空').max(256),
  enabled: z.boolean(),
  capabilities: aliasCapabilitiesSchema,
  upstreamPrice: modelUpstreamPriceSchema.nullish().transform(value => value ?? null),
  prices: z.array(modelPriceVersionSchema).max(1000),
  createTime: z.string(),
  updateTime: z.string(),
});

export type ProviderModel = z.infer<typeof providerModelSchema>;

export const modelConfigProviderSchema = z.strictObject({
  id: modelProviderIdSchema,
  displayName: z.string().min(1).max(128),
  apiFormat: z.enum(providerApiFormats),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('env'), env: modelApiKeyEnvSchema }),
    z.strictObject({ source: z.literal('inline'), ciphertext: modelApiKeyCiphertextSchema }),
  ]),
  options: providerOptionsSchema,
  headers: providerHeadersSchema.optional().transform(value => value ?? {}),
  enabled: z.boolean(),
  models: z.array(providerModelSchema),
  createTime: z.string(),
  updateTime: z.string(),
});

export type ModelConfigProvider = z.infer<typeof modelConfigProviderSchema>;

export const modelSlotAssignmentSchema = z.strictObject({
  slot: z.string().min(1).max(64),
  modelId: z.string().min(1).max(64),
  settings: aliasSettingsSchema,
});

export type ModelSlotAssignment = z.infer<typeof modelSlotAssignmentSchema>;

/** 迁移时无法对应到任何当前模型的旧费率；只供历史步骤解析，不展示成当前价格。 */
export const legacyPriceSchema = z.strictObject({
  providerId: z.string(),
  modelName: z.string(),
  effectiveFrom: z.string(),
  creditInputMiss: z.number().int(),
  creditInputHit: z.number().int(),
  creditOutput: z.number().int(),
  usdInputMiss: z.string().nullable().optional().transform(value => value ?? null),
  usdInputHit: z.string().nullable().optional().transform(value => value ?? null),
  usdOutput: z.string().nullable().optional().transform(value => value ?? null),
  costBasis: z.enum(['peak', 'off-peak', 'unknown']).nullable().optional().transform(value => value ?? null),
  costSource: z.string().nullable().optional().transform(value => value ?? null),
  note: z.string().nullable().optional().transform(value => value ?? null),
  createdBy: z.string().nullable().optional().transform(value => value ?? null),
  createTime: z.string().optional().transform(value => value ?? ''),
});

export type LegacyPrice = z.infer<typeof legacyPriceSchema>;

export const modelConfigDocumentSchema = z.strictObject({
  schemaVersion: z.literal(modelConfigSchemaVersion),
  providers: z.array(modelConfigProviderSchema),
  slots: z.array(modelSlotAssignmentSchema),
  legacyPrices: z.array(legacyPriceSchema).optional().transform(value => value ?? []),
});

export type ModelConfigDocument = z.infer<typeof modelConfigDocumentSchema>;

export function emptyModelConfigDocument(): ModelConfigDocument {
  return { schemaVersion: modelConfigSchemaVersion, providers: [], slots: [], legacyPrices: [] };
}

/** UTC 朴素时间戳（与数据库 `now()` 同格式），带毫秒。 */
export function utcTimestamp(now: string = new Date().toISOString()): string {
  return now.slice(0, 23).replace('T', ' ');
}

function instantOf(timestamp: string): number {
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`);
}

/** 当前有效价：`effectiveAt` 不晚于 `at` 的最新版本；未来价不会提前生效。 */
export function currentPriceOf(model: Pick<ProviderModel, 'prices'>, at: string = utcTimestamp()): ModelPriceVersion | null {
  const atMs = instantOf(at);
  if (Number.isNaN(atMs)) return null;
  let current: ModelPriceVersion | null = null;
  let currentMs = Number.NEGATIVE_INFINITY;
  for (const price of model.prices) {
    const ms = instantOf(price.effectiveAt);
    if (Number.isNaN(ms) || ms > atMs) continue;
    if (ms >= currentMs) {
      current = price;
      currentMs = ms;
    }
  }
  return current;
}

/** 模型是否可用于槽位分配；返回 null 表示可用。 */
export function modelEligibilityIssue(
  provider: Pick<ModelConfigProvider, 'enabled'>,
  model: Pick<ProviderModel, 'enabled' | 'capabilities' | 'prices' | 'upstream'>,
  slot: { readonly requires: readonly ('streaming' | 'toolCalling' | 'structuredOutput')[]; readonly label: string } | null,
  at: string = utcTimestamp(),
): string | null {
  if (!provider.enabled) return `提供商已停用，模型 ${model.upstream} 不能分配`;
  if (!model.enabled) return `模型 ${model.upstream} 已停用，不能分配`;
  if (!currentPriceOf(model, at)) return `模型 ${model.upstream} 还没有当前生效的单价，不能分配`;
  if (slot) {
    const missing = missingSlotCapabilities(slot, model.capabilities);
    if (missing.length) {
      return `槽位${slot.label}需要${missing.map(item => modelCapabilityLabels[item]).join('、')}能力；模型 ${model.upstream} 未声明`;
    }
  }
  return null;
}

/** 按文档顺序查找模型，返回提供商与模型的组合。 */
export function findDocumentModel(document: ModelConfigDocument, modelId: string) {
  for (const provider of document.providers) {
    const model = provider.models.find(candidate => candidate.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

/**
 * 文档级校验：结构、唯一性、槽位引用与必需槽位。价格/能力是否满足某个槽位属于分配时的检查，
 * 允许现有分配在模型停用或能力调整后变成「不可用」，界面会标红要求重新配置。
 */
export function modelConfigDocumentIssues(document: ModelConfigDocument, policy: ModelConfigPolicy): string[] {
  const issues: string[] = [];
  const providerIds = new Set<string>();
  const modelIds = new Set<string>();
  const upstreamKeys = new Set<string>();
  for (const provider of document.providers) {
    if (providerIds.has(provider.id)) issues.push(`提供商标识重复：${provider.id}`);
    providerIds.add(provider.id);
    const urlIssue = modelBaseUrlIssue(provider.baseUrl, policy);
    if (urlIssue) issues.push(`提供商 ${provider.id} 的地址不合法：${urlIssue}`);
    if (provider.apiKey.source === 'env' && !isAllowedModelApiKeyEnv(provider.apiKey.env, policy.allowedApiKeyEnvs)) {
      issues.push(`提供商 ${provider.id} 引用了未允许的环境变量 ${provider.apiKey.env}`);
    }
    const optionsIssue = providerOptionsIssue(provider.apiFormat, provider.options);
    if (optionsIssue) issues.push(`提供商 ${provider.id}：${optionsIssue}`);
    const supportedOptions = new Set(providerOptionKeysByFormat[provider.apiFormat]);
    for (const key of Object.keys(provider.options)) {
      if (!supportedOptions.has(key as never)) issues.push(`提供商 ${provider.id} 的选项 ${key} 不被 ${provider.apiFormat} 支持`);
    }
    for (const model of provider.models) {
      if (modelIds.has(model.id)) issues.push(`模型标识重复：${model.id}`);
      modelIds.add(model.id);
      const upstreamKey = `${provider.id}\u0000${model.upstream}`;
      if (upstreamKeys.has(upstreamKey)) issues.push(`提供商 ${provider.id} 下上游模型名重复：${model.upstream}`);
      upstreamKeys.add(upstreamKey);
      const versions = new Set<number>();
      const effectiveTimes = new Set<string>();
      for (const price of model.prices) {
        if (versions.has(price.version)) issues.push(`模型 ${model.upstream} 的价格版本重复：${price.version}`);
        versions.add(price.version);
        if (effectiveTimes.has(price.effectiveAt)) issues.push(`模型 ${model.upstream} 在 ${price.effectiveAt} 已有价格版本`);
        effectiveTimes.add(price.effectiveAt);
      }
    }
  }
  const modelOwners = new Map<string, string>();
  for (const provider of document.providers) {
    for (const model of provider.models) modelOwners.set(model.id, provider.id);
  }
  const slotNames = new Set<string>();
  for (const assignment of document.slots) {
    if (slotNames.has(assignment.slot)) issues.push(`槽位重复：${assignment.slot}`);
    slotNames.add(assignment.slot);
    if (!modelSlotOf(assignment.slot)) issues.push(`未知槽位：${assignment.slot}`);
    if (!modelOwners.has(assignment.modelId)) issues.push(`槽位 ${assignment.slot} 指向不存在的模型 ${assignment.modelId}`);
  }
  for (const slot of modelSlots) {
    if (!slot.optional && !slotNames.has(slot.slot)) {
      issues.push(`缺少必需槽位${slot.label}（${slot.slot}）：${slot.missingImpact}`);
    }
  }
  for (const legacy of document.legacyPrices) {
    if (!legacy.providerId || !legacy.modelName || Number.isNaN(instantOf(legacy.effectiveFrom))) {
      issues.push('历史费率包含无法解析的提供商、模型或生效时间');
      break;
    }
  }
  return issues;
}

/** 把 JSON 文档映射到注册表沿用的快照形状：每个已分配槽位合成一个别名。 */
export function snapshotFromDocument(document: ModelConfigDocument, revision: string, refreshEpoch: string): ModelConfigSnapshot {
  const providers: ModelProvider[] = document.providers.map(provider => ({
    ...modelProviderInputSchema.parse({
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    options: provider.options,
    headers: provider.headers,
    enabled: provider.enabled,
      ...(provider.apiKey.source === 'env'
        ? { apiKeySource: 'env', apiKeyEnv: provider.apiKey.env }
        : { apiKeySource: 'inline', apiKeyCiphertext: provider.apiKey.ciphertext }),
    }),
    createTime: provider.createTime,
    updateTime: provider.updateTime,
  }));
  const aliases: ModelAlias[] = [];
  for (const assignment of document.slots) {
    const found = findDocumentModel(document, assignment.modelId);
    if (!found) continue;
    aliases.push({
      alias: assignment.slot,
      providerId: found.provider.id,
      modelName: found.model.upstream,
      capabilities: found.model.capabilities,
      settings: assignment.settings,
      enabled: found.model.enabled,
      createTime: found.model.createTime,
      updateTime: found.model.updateTime,
    });
  }
  return { revision, refreshEpoch, providers, aliases };
}

export function providerInputFromDocument(provider: ModelConfigProvider): ModelProviderInput {
  return modelProviderInputSchema.parse({
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    options: provider.options,
    headers: provider.headers,
    enabled: provider.enabled,
    ...(provider.apiKey.source === 'env'
      ? { apiKeySource: 'env', apiKeyEnv: provider.apiKey.env }
      : { apiKeySource: 'inline', apiKeyCiphertext: provider.apiKey.ciphertext }),
  });
}

export function requiredSlotAssignmentsPresent(document: ModelConfigDocument): boolean {
  const assigned = new Set(document.slots.map(slot => slot.slot));
  return requiredModelAliases.every(slot => assigned.has(slot));
}

// ---- 管理端读模型与写操作契约 ----

export const modelPriceViewSchema = modelPriceVersionSchema;

export const modelAdminModelViewSchema = z.strictObject({
  id: z.string(),
  providerId: z.string(),
  upstream: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  capabilities: aliasCapabilitiesSchema,
  upstreamPrice: modelUpstreamPriceSchema.nullable(),
  prices: z.array(modelPriceVersionSchema),
  currentPrice: modelPriceVersionSchema.nullable(),
  createTime: z.string(),
  updateTime: z.string(),
});

export type ModelAdminModelView = z.infer<typeof modelAdminModelViewSchema>;

const providerViewFields = {
  id: z.string(),
  displayName: z.string(),
  apiFormat: z.enum(providerApiFormats),
  baseUrl: z.string(),
  options: providerOptionsSchema,
  headers: providerHeadersSchema,
  enabled: z.boolean(),
  createTime: z.string(),
  updateTime: z.string(),
  apiKeyConfigured: z.boolean(),
};

export const modelAdminProviderViewSchema = z.discriminatedUnion('apiKeySource', [
  z.strictObject({ ...providerViewFields, apiKeySource: z.literal('env'), apiKeyEnv: modelApiKeyEnvSchema, models: z.array(modelAdminModelViewSchema) }),
  z.strictObject({ ...providerViewFields, apiKeySource: z.literal('inline'), models: z.array(modelAdminModelViewSchema) }),
]);

export type ModelAdminProviderView = z.infer<typeof modelAdminProviderViewSchema>;

export const modelAssignmentViewSchema = z.strictObject({
  slot: z.string(),
  modelId: z.string(),
  settings: aliasSettingsSchema,
});

export type ModelAssignmentView = z.infer<typeof modelAssignmentViewSchema>;

export const modelAdminConfigViewSchema = z.strictObject({
  revision: z.string(),
  refreshEpoch: z.string(),
  initialized: z.boolean(),
  documentBytes: z.number().int(),
  providers: z.array(modelAdminProviderViewSchema),
  assignments: z.array(modelAssignmentViewSchema),
  slotDefinitions: z.array(z.strictObject({
    slot: z.string(),
    label: z.string(),
    purpose: z.string(),
    requires: z.array(z.enum(['streaming', 'toolCalling', 'structuredOutput'])),
    optional: z.boolean(),
    missingImpact: z.string(),
  })),
  providerFormats: z.array(z.strictObject({
    value: z.enum(providerApiFormats),
    label: z.string(),
    optionKeys: z.array(z.string()),
  })),
  allowedApiKeyEnvs: z.array(z.string()),
  instance: z.strictObject({
    revision: z.string().nullable(),
    refreshEpoch: z.string().nullable(),
    source: z.enum(['database', 'environment']).nullable(),
    degraded: z.boolean(),
    readAt: z.number().nullable(),
    loadedAt: z.number().nullable(),
    lastError: z.string().nullable(),
  }),
});

export type ModelAdminConfigView = z.infer<typeof modelAdminConfigViewSchema>;

export const modelPriceMutationSchema = z.strictObject({
  kind: z.literal('model.price'),
  modelId: z.string().min(1),
  inputMissFen: cnyFen,
  inputHitFen: cnyFen,
  outputFen: cnyFen,
  upstreamUsd: usdReferenceSchema.nullish().transform(value => value ?? null),
  note: z.string().max(2000).nullish().transform(value => value ?? null),
}).refine(value => value.inputMissFen > 0 || value.inputHitFen > 0 || value.outputFen > 0, '三个单价不能同时为 0');

export const modelConfigMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider.upsert'), provider: z.unknown() }),
  z.strictObject({ kind: z.literal('provider.delete'), providerId: modelProviderIdSchema }),
  z.strictObject({
    kind: z.literal('model.upsert'),
    providerId: modelProviderIdSchema,
    modelId: z.string().min(1).max(64).optional(),
    upstream: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(256),
    capabilities: aliasCapabilitiesSchema,
    enabled: z.boolean(),
    upstreamPrice: modelUpstreamPriceSchema.nullish().transform(value => value ?? null),
  }),
  modelPriceMutationSchema,
  z.strictObject({ kind: z.literal('model.enabled'), modelId: z.string().min(1), enabled: z.boolean() }),
  z.strictObject({
    kind: z.literal('slot.assign'),
    slot: z.string().min(1).max(64),
    modelId: z.string().min(1),
    settings: aliasSettingsSchema,
  }),
  z.strictObject({ kind: z.literal('slot.clear'), slot: z.string().min(1).max(64) }),
]);

export type ModelConfigMutation = z.infer<typeof modelConfigMutationSchema>;

export const modelConfigMutatePayloadSchema = z.strictObject({
  expectedRevision: z.string(),
  applyImmediately: z.boolean().optional(),
  mutation: modelConfigMutationSchema,
});

export type ModelConfigMutatePayload = z.infer<typeof modelConfigMutatePayloadSchema>;

export const modelConfigVersionViewSchema = z.strictObject({
  revision: z.string(),
  refreshEpoch: z.string(),
});

export type ModelConfigVersionView = z.infer<typeof modelConfigVersionViewSchema>;

/** UI 价格输入：元，最多两位小数；服务端只收整数分。 */
export function yuanToFen(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const fen = Math.round(n * 100);
  return Number.isSafeInteger(fen) ? fen : null;
}

export function fenToYuan(fen: number): number {
  return fen / 100;
}

export function formatCny(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '—';
  const yuan = fenToYuan(fen);
  return `¥${Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)}`;
}

export function formatUsd(value: string | null | undefined): string {
  return value === null || value === undefined ? '未知' : `$${value}`;
}

export const modelProviderFormatValues = providerApiFormats;
export type ModelDocumentApiFormat = ProviderApiFormat;
export type ModelDocumentProviderView = ModelAdminProviderView & ModelProviderView;
