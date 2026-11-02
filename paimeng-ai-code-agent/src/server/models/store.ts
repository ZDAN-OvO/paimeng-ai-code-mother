import 'server-only';
import { eq } from 'drizzle-orm';
import { getConfig } from '../infra/config';
import { db, now, type Transaction } from '../infra/db';
import { BusinessError } from '../infra/http';
import { appConfig } from '../infra/schema';
import { nextSnowflakeId } from '../infra/snowflake';
import {
  baseModelApiKeyEnv,
  decimalVersionSchema,
  defaultModelProviderId,
  modelProviderInputSchema,
  modelProviderWriteSchema,
  modelSlotOf,
  modelSlots,
  type ModelAlias,
  type ModelConfigSnapshot,
  type ModelConfigVersion,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderWriteInput,
} from '@/shared/model-config';
import {
  findDocumentModel,
  modelConfigDocumentIssues,
  modelConfigDocumentSchema,
  modelConfigKey,
  modelConfigMutatePayloadSchema,
  modelEligibilityIssue,
  providerInputFromDocument,
  snapshotFromDocument,
  utcTimestamp,
  type ModelConfigDocument,
  type ModelConfigMutation,
  type ModelConfigProvider,
  type ModelPriceVersion,
  type ProviderModel,
} from '@/shared/model-document';
import { ModelConfigInvalidError } from './errors';
import { encryptModelSecret } from './secrets';

/**
 * 模型配置存储层：一行 `app_config.value` JSON 文档。
 *
 * - 读：`readConfigSnapshot` 在 REPEATABLE READ 事务里读同一行，再映射成注册表沿用的
 *   providers/aliases 快照；`readModelConfigDocument` 给 billing 等模块在同一事务里读原文。
 * - 写：锁定唯一行、校验 expectedRevision、校验完整候选文档，再递增 revision；
 *   `applyImmediately` 额外递增 refresh_epoch。
 * - 初始化：仅当文档为空且版本为零时从环境变量建立默认提供商、一个模型和两个必需槽位。
 */

type ConfigRow = typeof appConfig.$inferSelect;
type ModelConfigWrite = { expectedRevision: string; applyImmediately?: boolean };

function policy() {
  const config = getConfig();
  return { allowedApiKeyEnvs: config.modelApiKeyEnvAllowlist, internalOrigins: config.modelInternalBaseUrlOrigins };
}

function parseDocument(raw: unknown): ModelConfigDocument {
  const parsed = modelConfigDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModelConfigInvalidError(`模型配置文档不合法：${issue?.path.join('.') || ''} ${issue?.message ?? ''}`.trim());
  }
  const empty = parsed.data.providers.length === 0 && parsed.data.slots.length === 0 && parsed.data.legacyPrices.length === 0;
  const issues = modelConfigDocumentIssues(parsed.data, policy())
    // 空文档是合法引导状态：注册表会回退到环境变量，管理端显示未初始化；只有写入候选时才要求必需槽位。
    .filter(issue => !(empty && issue.startsWith('缺少必需槽位')));
  if (issues.length) throw new ModelConfigInvalidError(issues.join('；'));
  return parsed.data;
}

function versionOf(row: Pick<ConfigRow, 'revision' | 'refreshEpoch'>): ModelConfigVersion {
  return { revision: row.revision.toString(), refreshEpoch: row.refreshEpoch.toString() };
}

function smallVersion(value: bigint): string {
  return value.toString();
}

function assertRevision(revision: bigint, expectedRevision: string) {
  if (revision.toString() !== expectedRevision) {
    throw new BusinessError(409, 40901, `模型配置版本冲突，当前版本 ${revision.toString()}，请重新加载后再保存`);
  }
}

async function requireRow(tx: Transaction): Promise<ConfigRow> {
  const [row] = await tx.select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new BusinessError(503, 50300, '模型配置行缺失，请先执行数据库迁移');
  return row;
}

async function lockRow(tx: Transaction): Promise<ConfigRow> {
  const [row] = await tx.select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).for('update');
  if (!row) throw new BusinessError(503, 50300, '模型配置行缺失，请先执行数据库迁移');
  return row;
}

export type ModelConfigDocumentState = {
  document: ModelConfigDocument;
  revision: string;
  refreshEpoch: string;
};

/** 文档原文 + 版本（解析 + 语义校验后）。传事务句柄时跟随调用方的可见性快照。 */
export async function readModelConfigDocumentState(tx?: Transaction): Promise<ModelConfigDocumentState> {
  const [row] = await (tx ?? db()).select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new BusinessError(503, 50300, '模型配置行缺失，请先执行数据库迁移');
  return { document: parseDocument(row.value), revision: row.revision.toString(), refreshEpoch: row.refreshEpoch.toString() };
}

/** 只读文档原文；billing 在结算事务里只需要价格树。 */
export async function readModelConfigDocument(tx?: Transaction): Promise<ModelConfigDocument> {
  return (await readModelConfigDocumentState(tx)).document;
}

export async function readConfigSnapshot(): Promise<ModelConfigSnapshot> {
  return db().transaction(
    async tx => {
      const row = await requireRow(tx);
      const document = parseDocument(row.value);
      return snapshotFromDocument(document, smallVersion(row.revision), smallVersion(row.refreshEpoch));
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function readRefreshEpoch(): Promise<string> {
  const [row] = await db().select({ refreshEpoch: appConfig.refreshEpoch }).from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new BusinessError(503, 50300, '模型配置行缺失，请先执行数据库迁移');
  return row.refreshEpoch.toString();
}

/** 写入口径转存储口径：直接输入的密钥在这里加密；留空表示保持已保存的密文。 */
export function toStoredProvider(write: ModelProviderWriteInput, existing: ModelProvider | undefined): ModelProviderInput {
  const fields = {
    id: write.id,
    displayName: write.displayName,
    apiFormat: write.apiFormat,
    baseUrl: write.baseUrl,
    options: write.options,
    headers: write.headers ?? {},
    enabled: write.enabled,
  };
  if (write.apiKeySource === 'env') {
    return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'env', apiKeyEnv: write.apiKeyEnv });
  }
  const apiKey = write.apiKey.trim();
  if (!apiKey) {
    if (existing?.apiKeySource !== 'inline') throw new BusinessError(400, 40000, '请填写直接输入的密钥');
    return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'inline', apiKeyCiphertext: existing.apiKeyCiphertext });
  }
  return modelProviderInputSchema.parse({ ...fields, apiKeySource: 'inline', apiKeyCiphertext: encryptModelSecret(apiKey) });
}

function providerFromDocument(provider: ModelConfigProvider): ModelProvider {
  return {
    ...providerInputFromDocument(provider),
    createTime: provider.createTime,
    updateTime: provider.updateTime,
  };
}

function providerDocumentOf(input: ModelProviderInput, existing: ModelConfigProvider | null): ModelConfigProvider {
  const time = now();
  return {
    id: input.id,
    displayName: input.displayName,
    apiFormat: input.apiFormat,
    baseUrl: input.baseUrl,
    apiKey: input.apiKeySource === 'env'
      ? { source: 'env', env: input.apiKeyEnv }
      : { source: 'inline', ciphertext: input.apiKeyCiphertext },
    options: input.options,
    headers: input.headers ?? {},
    enabled: input.enabled,
    models: existing?.models ?? [],
    createTime: existing?.createTime ?? time,
    updateTime: time,
  };
}

function referencedSlots(document: ModelConfigDocument, modelId: string): string[] {
  return document.slots.filter(assignment => assignment.modelId === modelId).map(assignment => assignment.slot);
}

/** 让追加价格不会和同一毫秒的旧版本撞时间：取当前时刻与最新版本 + 1ms 的较大值。 */
function nextEffectiveAt(prices: readonly ModelPriceVersion[]): string {
  const at = now();
  const atMs = Date.parse(`${at.replace(' ', 'T')}Z`);
  const latest = prices.reduce((max, price) => {
    const ms = Date.parse(`${price.effectiveAt.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? max : Math.max(max, ms);
  }, Number.NEGATIVE_INFINITY);
  if (Number.isFinite(latest) && atMs <= latest) return utcTimestamp(new Date(latest + 1).toISOString());
  return at;
}

function nextPriceVersion(prices: readonly ModelPriceVersion[]): number {
  return prices.reduce((max, price) => Math.max(max, price.version), 0) + 1;
}

type MutationContext = { document: ModelConfigDocument; mutation: ModelConfigMutation };

async function applyMutation({ document, mutation }: MutationContext): Promise<ModelConfigDocument> {
  const next: ModelConfigDocument = {
    schemaVersion: document.schemaVersion,
    providers: document.providers,
    slots: document.slots,
    legacyPrices: document.legacyPrices,
  };
  switch (mutation.kind) {
    case 'provider.upsert': {
      const write = modelProviderWriteSchema.parse(mutation.provider);
      const index = next.providers.findIndex(provider => provider.id === write.id);
      const existing = index >= 0 ? next.providers[index] : null;
      const stored = toStoredProvider(write, existing ? providerFromDocument(existing) : undefined);
      const provider = providerDocumentOf(stored, existing);
      next.providers = index >= 0
        ? next.providers.map((candidate, replace) => replace === index ? provider : candidate)
        : [...next.providers, provider];
      return next;
    }
    case 'provider.delete': {
      const provider = next.providers.find(candidate => candidate.id === mutation.providerId);
      if (!provider) throw new BusinessError(404, 40400, '提供商不存在');
      if (provider.models.length) throw new BusinessError(409, 40902, `提供商 ${provider.id} 下还有 ${provider.models.length} 个模型，不能删除；请先停用提供商或清理模型`);
      next.providers = next.providers.filter(candidate => candidate.id !== provider.id);
      return next;
    }
    case 'model.upsert': {
      const providerIndex = next.providers.findIndex(provider => provider.id === mutation.providerId);
      const provider = next.providers[providerIndex];
      if (!provider) throw new BusinessError(404, 40400, '提供商不存在');
      const existing = mutation.modelId
        ? provider.models.find(model => model.id === mutation.modelId)
        : provider.models.find(model => model.upstream === mutation.upstream);
      if (mutation.modelId && !existing) throw new BusinessError(404, 40400, '模型不存在');
      if (existing) {
        if (existing.upstream !== mutation.upstream) throw new BusinessError(400, 40000, '上游模型名创建后不能修改；请新建模型并重新分配槽位');
        if (referencedSlots(document, existing.id).length && existing.enabled && !mutation.enabled) {
          throw new BusinessError(409, 40902, `模型 ${existing.upstream} 仍被槽位引用（${referencedSlots(document, existing.id).join('、')}），不能停用`);
        }
        const updated: ProviderModel = {
          ...existing,
          displayName: mutation.displayName,
          capabilities: mutation.capabilities,
          enabled: mutation.enabled,
          upstreamPrice: mutation.upstreamPrice,
          updateTime: now(),
        };
        next.providers = next.providers.map((candidate, index) => index === providerIndex
          ? { ...candidate, models: candidate.models.map(model => model.id === existing.id ? updated : model) }
          : candidate);
        return next;
      }
      if (provider.models.some(model => model.upstream === mutation.upstream)) {
        throw new BusinessError(409, 40900, `提供商 ${provider.id} 下已经有上游模型名 ${mutation.upstream}`);
      }
      const time = now();
      const model: ProviderModel = {
        id: `pm_${(await nextSnowflakeId()).toString()}`,
        upstream: mutation.upstream,
        displayName: mutation.displayName,
        enabled: mutation.enabled,
        capabilities: mutation.capabilities,
        upstreamPrice: mutation.upstreamPrice,
        prices: [],
        createTime: time,
        updateTime: time,
      };
      next.providers = next.providers.map((candidate, index) => index === providerIndex
        ? { ...candidate, models: [...candidate.models, model] }
        : candidate);
      return next;
    }
    case 'model.price': {
      const found = findDocumentModel(next, mutation.modelId);
      if (!found) throw new BusinessError(404, 40400, '模型不存在');
      const price: ModelPriceVersion = {
        version: nextPriceVersion(found.model.prices),
        effectiveAt: nextEffectiveAt(found.model.prices),
        currency: 'CNY',
        inputMissFen: mutation.inputMissFen,
        inputHitFen: mutation.inputHitFen,
        outputFen: mutation.outputFen,
        upstreamUsd: mutation.upstreamUsd,
        note: mutation.note,
      };
      next.providers = next.providers.map(provider => provider.id === found.provider.id
        ? {
          ...provider,
          models: provider.models.map(model => model.id === found.model.id
            ? { ...model, prices: [...model.prices, price], updateTime: now() }
            : model),
        }
        : provider);
      return next;
    }
    case 'model.enabled': {
      const found = findDocumentModel(next, mutation.modelId);
      if (!found) throw new BusinessError(404, 40400, '模型不存在');
      if (!mutation.enabled) {
        const slots = referencedSlots(document, found.model.id);
        if (slots.length) throw new BusinessError(409, 40902, `模型 ${found.model.upstream} 仍被槽位引用（${slots.join('、')}），不能停用`);
      }
      next.providers = next.providers.map(provider => provider.id === found.provider.id
        ? {
          ...provider,
          models: provider.models.map(model => model.id === found.model.id
            ? { ...model, enabled: mutation.enabled, updateTime: now() }
            : model),
        }
        : provider);
      return next;
    }
    case 'slot.assign': {
      const slot = modelSlotOf(mutation.slot);
      if (!slot) throw new BusinessError(400, 40000, `未知槽位：${mutation.slot}`);
      const found = findDocumentModel(next, mutation.modelId);
      if (!found) throw new BusinessError(404, 40400, '模型不存在');
      const issue = modelEligibilityIssue(found.provider, found.model, slot);
      if (issue) throw new BusinessError(400, 40000, issue);
      const assignment = { slot: mutation.slot, modelId: mutation.modelId, settings: mutation.settings };
      next.slots = next.slots.some(candidate => candidate.slot === mutation.slot)
        ? next.slots.map(candidate => candidate.slot === mutation.slot ? assignment : candidate)
        : [...next.slots, assignment];
      return next;
    }
    case 'slot.clear': {
      const slot = modelSlotOf(mutation.slot);
      if (!slot) throw new BusinessError(400, 40000, `未知槽位：${mutation.slot}`);
      if (!next.slots.some(assignment => assignment.slot === mutation.slot)) throw new BusinessError(404, 40400, '该槽位还没有分配模型');
      if (!slot.optional) throw new BusinessError(409, 40902, `必需槽位${slot.label}（${mutation.slot}）不能清除，请改为分配另一个可用模型`);
      next.slots = next.slots.filter(assignment => assignment.slot !== mutation.slot);
      return next;
    }
    default: {
      const exhaustive: never = mutation;
      throw new Error(`未知模型配置操作 ${String(exhaustive)}`);
    }
  }
}

function assertDocumentValid(document: ModelConfigDocument) {
  const issues = modelConfigDocumentIssues(document, policy());
  if (issues.length) throw new BusinessError(400, 40000, issues.join('；'));
}

export async function mutateModelConfig(raw: unknown): Promise<ModelConfigVersion> {
  const payload = modelConfigMutatePayloadSchema.parse(raw);
  const parsedRevision = decimalVersionSchema.safeParse(payload.expectedRevision);
  if (!parsedRevision.success) throw new BusinessError(400, 40000, '模型配置版本号不合法');
  return db().transaction(async tx => {
    const row = await lockRow(tx);
    assertRevision(row.revision, payload.expectedRevision);
    const document = parseDocument(row.value);
    const candidate = await applyMutation({ document, mutation: payload.mutation });
    assertDocumentValid(candidate);
    const revision = row.revision + 1n;
    const refreshEpoch = payload.applyImmediately ? row.refreshEpoch + 1n : row.refreshEpoch;
    await tx.update(appConfig).set({
      value: candidate,
      revision,
      refreshEpoch,
      updatedAt: now(),
    }).where(eq(appConfig.key, modelConfigKey));
    return { revision: revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export async function applyModelConfig(write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return db().transaction(async tx => {
    const row = await lockRow(tx);
    assertRevision(row.revision, write.expectedRevision);
    parseDocument(row.value);
    const refreshEpoch = row.refreshEpoch + 1n;
    await tx.update(appConfig).set({ refreshEpoch, updatedAt: now() }).where(eq(appConfig.key, modelConfigKey));
    return { revision: row.revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export type ModelInitializationResult = { initialized: boolean; revision: string; refreshEpoch: string; providerId: string | null };

export async function initializeModelConfigFromEnv(): Promise<ModelInitializationResult> {
  const config = getConfig();
  return db().transaction(async tx => {
    const row = await lockRow(tx);
    const document = parseDocument(row.value);
    if (document.providers.length || document.slots.length) {
      return { initialized: false, ...versionOf(row), providerId: null };
    }
    if (row.revision !== 0n || row.refreshEpoch !== 0n) {
      throw new BusinessError(409, 40903, '模型配置状态不一致：版本非零但配置为空，请人工确认后再初始化');
    }
    if (!config.aiModel) throw new BusinessError(400, 40000, 'AI_MODEL 为空，无法从环境变量初始化模型配置');
    const time = now();
    const modelId = `pm_${(await nextSnowflakeId()).toString()}`;
    const provider: ModelConfigProvider = {
      id: defaultModelProviderId,
      displayName: '环境默认提供商',
      apiFormat: 'openai-chat',
      baseUrl: config.aiBaseUrl,
      apiKey: { source: 'env', env: baseModelApiKeyEnv },
      options: {},
      headers: {},
      enabled: true,
      models: [{
        id: modelId,
        upstream: config.aiModel,
        displayName: config.aiModel,
        enabled: true,
        capabilities: { streaming: true, toolCalling: true, structuredOutput: true, imageInput: false },
        upstreamPrice: null,
        prices: [],
        createTime: time,
        updateTime: time,
      }],
      createTime: time,
      updateTime: time,
    };
    const slots = modelSlots.filter(slot => !slot.optional).map(slot => ({
      slot: slot.slot,
      modelId,
      settings: {},
    }));
    const initial: ModelConfigDocument = {
      schemaVersion: 1,
      providers: [provider],
      slots,
      legacyPrices: [],
    };
    assertDocumentValid(initial);
    const revision = row.revision + 1n;
    await tx.update(appConfig).set({
      value: initial,
      revision,
      refreshEpoch: row.refreshEpoch,
      updatedAt: now(),
    }).where(eq(appConfig.key, modelConfigKey));
    return { initialized: true, revision: revision.toString(), refreshEpoch: row.refreshEpoch.toString(), providerId: defaultModelProviderId };
  });
}

/** 兼容旧调用点的薄包装：提供商写入统一走 JSON 变更入口。 */
export async function upsertProvider(provider: ModelProviderWriteInput, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return mutateModelConfig({
    expectedRevision: write.expectedRevision,
    applyImmediately: write.applyImmediately,
    mutation: { kind: 'provider.upsert', provider },
  });
}

export async function deleteProvider(id: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return mutateModelConfig({
    expectedRevision: write.expectedRevision,
    mutation: { kind: 'provider.delete', providerId: id },
  });
}

/** 旧「删除别名」语义 = 清空槽位分配；必需槽位会被拒绝。 */
export async function deleteAlias(alias: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return mutateModelConfig({
    expectedRevision: write.expectedRevision,
    mutation: { kind: 'slot.clear', slot: alias },
  });
}
