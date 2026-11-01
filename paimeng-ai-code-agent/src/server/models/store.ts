import 'server-only';
import { eq } from 'drizzle-orm';
import { getConfig } from '../infra/config';
import { db, now, type Transaction } from '../infra/db';
import { BusinessError } from '../infra/http';
import { modelAliases, modelConfigState, modelProviders, providerModels } from '../infra/schema';
import { nextSnowflakeId, nextSnowflakeIdInTransaction } from '../infra/snowflake';
import {
  baseModelApiKeyEnv,
  capabilitiesForSlot,
  defaultModelProviderId,
  missingSlotCapabilities,
  modelAliasInputSchema,
  modelCapabilityLabels,
  modelConfigIssues,
  modelConfigStateId,
  modelProviderInputSchema,
  modelSlotOf,
  modelSlots,
  providerModelIdSchema,
  providerModelInputSchema,
  providerModelUpdateSchema,
  requiredModelAliases,
  type ModelAlias,
  type ModelAliasInput,
  type ModelConfigPolicy,
  type ModelConfigSnapshot,
  type ModelConfigVersion,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderWriteInput,
  type ProviderModel,
  type ProviderModelInput,
  type ProviderModelUpdate,
} from '@/shared/model-config';
import { encryptModelSecret } from './secrets';

/**
 * 配置存储层的对外接口（供热加载与管理 API 使用）：
 * - readConfigSnapshot：一个显式 REPEATABLE READ 只读事务内加载状态行、提供商、提供商模型与别名。
 * - readRefreshEpoch：轻量读取共享刷新序号，供每次模型解析前检查。
 * - upsertProvider / deleteProvider / upsertAlias / deleteAlias / applyModelConfig：
 *   锁定状态行、检查 expectedRevision、校验完整候选配置后写入并递增版本。
 * - initializeModelConfigFromEnv：仅当配置为空且版本为零时从环境变量建立提供商与两个必需别名。
 */

type ModelConfigWrite = { expectedRevision: string; applyImmediately?: boolean };
export type ModelConfigMutation =
  | { kind: 'upsertProvider'; provider: ModelProviderWriteInput }
  | { kind: 'deleteProvider'; id: string }
  | { kind: 'upsertAlias'; alias: ModelAliasInput }
  | { kind: 'deleteAlias'; alias: string }
  | { kind: 'createProviderModel'; id: string; model: ProviderModelInput }
  | { kind: 'updateProviderModel'; id: string; update: ProviderModelUpdate };

/** 存储口径的变更：直接输入的密钥已换成密文，其余与写入口径一致。 */
type StoredModelConfigMutation =
  | { kind: 'upsertProvider'; provider: ModelProviderInput }
  | { kind: 'deleteProvider'; id: string }
  | { kind: 'upsertAlias'; alias: ModelAliasInput }
  | { kind: 'deleteAlias'; alias: string }
  | { kind: 'createProviderModel'; id: string; model: ProviderModelInput }
  | { kind: 'updateProviderModel'; id: string; update: ProviderModelUpdate };

/**
 * 写入口径转存储口径：直接输入的密钥在这里加密。
 * 提交空密钥表示保持已保存的密钥（仅当原来就是直接输入时有效），避免管理端必须回填明文。
 */
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

function storageMutation(mutation: ModelConfigMutation, providers: readonly ModelProvider[]): StoredModelConfigMutation {
  if (mutation.kind !== 'upsertProvider') return mutation;
  return { kind: 'upsertProvider', provider: toStoredProvider(mutation.provider, providers.find(provider => provider.id === mutation.provider.id)) };
}

function modelConfigPolicy(): ModelConfigPolicy {
  const config = getConfig();
  return { allowedApiKeyEnvs: config.modelApiKeyEnvAllowlist, internalOrigins: config.modelInternalBaseUrlOrigins };
}

function providerFromRow(row: typeof modelProviders.$inferSelect): ModelProvider {
  const fields = {
    id: row.id,
    displayName: row.displayName,
    apiFormat: row.apiFormat,
    baseUrl: row.baseUrl,
    options: row.options,
    headers: row.headers ?? {},
    enabled: row.enabled === 1,
  };
  return {
    ...modelProviderInputSchema.parse(
      row.apiKeyCiphertext
        ? { ...fields, apiKeySource: 'inline' as const, apiKeyCiphertext: row.apiKeyCiphertext }
        : { ...fields, apiKeySource: 'env' as const, apiKeyEnv: row.apiKeyEnv },
    ),
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

function aliasFromRow(row: typeof modelAliases.$inferSelect): ModelAlias {
  return {
    ...modelAliasInputSchema.parse({
      alias: row.alias,
      providerModelId: row.providerModelId === null ? null : row.providerModelId.toString(),
      providerId: row.providerId,
      modelName: row.modelName,
      capabilities: row.capabilities,
      settings: row.settings,
      enabled: row.enabled === 1,
    }),
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

function providerModelFromRow(row: typeof providerModels.$inferSelect): ProviderModel {
  return {
    ...providerModelInputSchema.parse({
      providerId: row.providerId,
      upstreamModelName: row.upstreamModelName,
      displayName: row.displayName,
      capabilities: row.capabilities,
      compatibility: row.compatibility,
      enabled: row.enabled === 1,
    }),
    id: row.id.toString(),
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

async function requireState(tx: Transaction) {
  const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1);
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state;
}

async function lockState(tx: Transaction) {
  const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).for('update');
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state;
}

async function readProviderRows(tx: Transaction) {
  return (await tx.select().from(modelProviders)).map(providerFromRow);
}

async function readProviderModelRows(tx: Transaction) {
  return (await tx.select().from(providerModels)).map(providerModelFromRow);
}

async function readAliasRows(tx: Transaction) {
  return (await tx.select().from(modelAliases)).map(aliasFromRow);
}

function assertRevision(revision: bigint, expectedRevision: string) {
  if (revision.toString() !== expectedRevision) {
    throw new BusinessError(409, 40901, `模型配置版本冲突，当前版本 ${revision.toString()}，请重新加载后再保存`);
  }
}

/** 一次性回填工具复用同一把状态行锁与版本校验，避免出现第二套并发语义。 */
export const lockModelConfigState = lockState;
export const assertModelConfigRevision = assertRevision;

/** drizzle 把 SQL 错误包在 cause 里，唯一键冲突的 23505 要顺着 cause 链找。 */
function uniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: string }).code === '23505') return true;
  }
  return false;
}

function assertValid(providers: readonly ModelProviderInput[], aliases: readonly ModelAliasInput[]) {
  const issues = modelConfigIssues(providers, aliases, modelConfigPolicy());
  if (issues.length) throw new BusinessError(400, 40000, issues.join('；'));
}

/**
 * 槽位写入口径以模型为唯一身份：带 providerModelId 时，提供商、请求名与能力都从模型派生，
 * 客户端另填的值不参与存储。过渡期不传 ID 的旧页面保留已有链接；显式 null 才解除。
 */
function normalizeAlias(mutation: ModelAliasInput, existing: ModelAlias | undefined, models: readonly ProviderModel[]): ModelAliasInput {
  if (mutation.providerModelId === undefined) {
    const linked = existing?.providerModelId ? models.find(candidate => candidate.id === existing.providerModelId) : undefined;
    // 旧页面只送了同样的提供商/请求名：保留已有链接，继续以模型为身份。
    if (linked && mutation.providerId === linked.providerId && mutation.modelName === linked.upstreamModelName) {
      return { ...mutation, providerModelId: linked.id, capabilities: linked.capabilities };
    }
    // 旧页面把槽位改到另一家提供商/模型：按旧语义重新指向，并解除旧链接。
    return { ...mutation, providerModelId: null };
  }
  const requested = mutation.providerModelId;
  if (requested === null) return { ...mutation, providerModelId: null };
  const model = models.find(candidate => candidate.id === requested);
  if (!model) throw new BusinessError(404, 40400, `提供商模型 ${requested} 不存在`);
  if (mutation.enabled && !model.enabled) {
    throw new BusinessError(409, 40902, `提供商模型 ${requested} 已停用，启用中的槽位不能引用`);
  }
  return {
    ...mutation,
    providerModelId: model.id,
    providerId: model.providerId,
    modelName: model.upstreamModelName,
    capabilities: model.capabilities,
  };
}

function applyMutation(
  mutation: StoredModelConfigMutation,
  providers: readonly ModelProvider[],
  providerModelRows: readonly ProviderModel[],
  aliases: readonly ModelAlias[],
): { providers: ModelProviderInput[]; providerModels: ProviderModel[]; aliases: ModelAliasInput[] } {
  switch (mutation.kind) {
    case 'upsertProvider': {
      const next: ModelProviderInput[] = providers.filter(provider => provider.id !== mutation.provider.id);
      next.push(mutation.provider);
      return { providers: next, providerModels: [...providerModelRows], aliases: [...aliases] };
    }
    case 'deleteProvider': {
      if (!providers.some(provider => provider.id === mutation.id)) throw new BusinessError(404, 40400, '提供商不存在');
      if (aliases.some(alias => alias.providerId === mutation.id)) throw new BusinessError(409, 40902, '提供商仍被别名引用，不能删除');
      if (providerModelRows.some(model => model.providerId === mutation.id)) throw new BusinessError(409, 40902, '提供商仍被提供商模型引用，不能删除');
      return { providers: providers.filter(provider => provider.id !== mutation.id), providerModels: [...providerModelRows], aliases: [...aliases] };
    }
    case 'upsertAlias': {
      const slot = modelSlotOf(mutation.alias.alias);
      if (!slot) {
        const names = modelSlots.map(candidate => `${candidate.label}（${candidate.slot}）`).join('、');
        throw new BusinessError(400, 40000, `模型分配只有四个固定槽位：${names}，不能自建 ${mutation.alias.alias}`);
      }
      const existing = aliases.find(alias => alias.alias === mutation.alias.alias);
      const next: ModelAliasInput[] = aliases.filter(alias => alias.alias !== mutation.alias.alias);
      next.push(normalizeAlias(mutation.alias, existing, providerModelRows));
      return { providers: [...providers], providerModels: [...providerModelRows], aliases: next };
    }
    case 'deleteAlias': {
      if (!aliases.some(alias => alias.alias === mutation.alias)) throw new BusinessError(404, 40400, '别名不存在');
      if ((requiredModelAliases as readonly string[]).includes(mutation.alias)) throw new BusinessError(409, 40902, `必需别名 ${mutation.alias} 不能删除`);
      return { providers: [...providers], providerModels: [...providerModelRows], aliases: aliases.filter(alias => alias.alias !== mutation.alias) };
    }
    case 'createProviderModel': {
      if (!providers.some(provider => provider.id === mutation.model.providerId)) {
        throw new BusinessError(404, 40400, `提供商 ${mutation.model.providerId} 不存在`);
      }
      if (providerModelRows.some(model => model.providerId === mutation.model.providerId && model.upstreamModelName === mutation.model.upstreamModelName)) {
        throw new BusinessError(409, 40904, `提供商 ${mutation.model.providerId} 下已有请求模型 ${mutation.model.upstreamModelName}，不能重复登记`);
      }
      const timestamp = now();
      return {
        providers: [...providers],
        providerModels: [...providerModelRows, { id: mutation.id, ...mutation.model, createTime: timestamp, updateTime: timestamp }],
        aliases: [...aliases],
      };
    }
    case 'updateProviderModel': {
      const existing = providerModelRows.find(model => model.id === mutation.id);
      if (!existing) throw new BusinessError(404, 40400, '提供商模型不存在');
      const updated: ProviderModel = { ...existing, ...mutation.update, updateTime: now() };
      const referencing = aliases.filter(alias => alias.providerModelId === mutation.id);
      for (const alias of referencing) {
        if (!alias.enabled) continue;
        if (!updated.enabled) throw new BusinessError(409, 40902, `槽位 ${alias.alias} 仍在启用，不能停用提供商模型 ${mutation.id}`);
        const slot = modelSlotOf(alias.alias);
        if (!slot) continue;
        const missing = missingSlotCapabilities(slot, updated.capabilities);
        if (missing.length) {
          const labels = missing.map(requirement => modelCapabilityLabels[requirement]).join('、');
          throw new BusinessError(409, 40902, `槽位 ${alias.alias} 仍需要${labels}能力，不能从提供商模型 ${mutation.id} 移除`);
        }
      }
      return {
        providers: [...providers],
        providerModels: providerModelRows.map(model => (model.id === mutation.id ? updated : model)),
        aliases: [...aliases],
      };
    }
    default: {
      const _exhaustive: never = mutation;
      throw new Error(`未知模型配置操作 ${String(_exhaustive)}`);
    }
  }
}

async function upsertProviderRow(tx: Transaction, provider: ModelProviderInput, existing: ModelProvider | undefined) {
  const set = {
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeySource === 'env' ? provider.apiKeyEnv : null,
    apiKeyCiphertext: provider.apiKeySource === 'inline' ? provider.apiKeyCiphertext : null,
    options: provider.options,
    headers: provider.headers ?? {},
    enabled: provider.enabled ? 1 : 0,
    updateTime: now(),
  };
  await tx.insert(modelProviders).values({ id: provider.id, ...set, createTime: existing?.createTime ?? now() }).onConflictDoUpdate({ target: modelProviders.id, set });
}

async function upsertAliasRow(tx: Transaction, alias: ModelAliasInput, existing: ModelAlias | undefined) {
  const set = {
    providerId: alias.providerId,
    providerModelId: alias.providerModelId === undefined || alias.providerModelId === null ? null : BigInt(alias.providerModelId),
    modelName: alias.modelName,
    capabilities: alias.capabilities,
    settings: alias.settings,
    enabled: alias.enabled ? 1 : 0,
    updateTime: now(),
  };
  await tx.insert(modelAliases).values({ alias: alias.alias, ...set, createTime: existing?.createTime ?? now() }).onConflictDoUpdate({ target: modelAliases.alias, set });
}

async function persistMutation(
  tx: Transaction,
  mutation: StoredModelConfigMutation,
  providers: readonly ModelProvider[],
  aliases: readonly ModelAlias[],
  nextProviderModels: readonly ProviderModel[],
  nextAliases: readonly ModelAliasInput[],
) {
  switch (mutation.kind) {
    case 'upsertProvider':
      await upsertProviderRow(tx, mutation.provider, providers.find(provider => provider.id === mutation.provider.id));
      return;
    case 'deleteProvider':
      await tx.delete(modelProviders).where(eq(modelProviders.id, mutation.id));
      return;
    case 'upsertAlias': {
      const alias = nextAliases.find(candidate => candidate.alias === mutation.alias.alias);
      if (!alias) throw new Error('写入槽位后未在候选快照中找到该别名');
      await upsertAliasRow(tx, alias, aliases.find(candidate => candidate.alias === mutation.alias.alias));
      return;
    }
    case 'deleteAlias':
      await tx.delete(modelAliases).where(eq(modelAliases.alias, mutation.alias));
      return;
    case 'createProviderModel': {
      const model = nextProviderModels.find(candidate => candidate.id === mutation.id);
      if (!model) throw new Error('创建提供商模型后未在候选快照中找到该记录');
      await tx.insert(providerModels).values({
        id: BigInt(model.id),
        providerId: model.providerId,
        upstreamModelName: model.upstreamModelName,
        displayName: model.displayName,
        capabilities: model.capabilities,
        compatibility: model.compatibility,
        enabled: model.enabled ? 1 : 0,
        createTime: model.createTime,
        updateTime: model.updateTime,
      });
      return;
    }
    case 'updateProviderModel': {
      const model = nextProviderModels.find(candidate => candidate.id === mutation.id);
      if (!model) throw new Error('更新提供商模型后未在候选快照中找到该记录');
      await tx.update(providerModels).set({
        displayName: model.displayName,
        capabilities: model.capabilities,
        compatibility: model.compatibility,
        enabled: model.enabled ? 1 : 0,
        updateTime: model.updateTime,
      }).where(eq(providerModels.id, BigInt(model.id)));
      return;
    }
  }
}

export async function readConfigSnapshot(): Promise<ModelConfigSnapshot> {
  return db().transaction(
    async tx => {
      const state = await requireState(tx);
      const providers = await readProviderRows(tx);
      const providerModelRows = await readProviderModelRows(tx);
      const aliases = await readAliasRows(tx);
      return {
        revision: state.revision.toString(),
        refreshEpoch: state.refreshEpoch.toString(),
        providers,
        providerModels: providerModelRows,
        aliases,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** 管理/回填工具直接读模型表；正常模型解析走 readConfigSnapshot 的一致性快照。 */
export async function readProviderModels(): Promise<ProviderModel[]> {
  return (await db().select().from(providerModels)).map(providerModelFromRow);
}

export async function readRefreshEpoch(): Promise<string> {
  const [state] = await db().select({ refreshEpoch: modelConfigState.refreshEpoch }).from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1);
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
  return state.refreshEpoch.toString();
}

export async function writeModelConfig(write: ModelConfigWrite, mutation: ModelConfigMutation): Promise<ModelConfigVersion> {
  return db().transaction(async tx => {
    const state = await lockState(tx);
    assertRevision(state.revision, write.expectedRevision);
    const providers = await readProviderRows(tx);
    const providerModelRows = await readProviderModelRows(tx);
    const aliases = await readAliasRows(tx);
    const stored = storageMutation(mutation, providers);
    const next = applyMutation(stored, providers, providerModelRows, aliases);
    assertValid(next.providers, next.aliases);
    await persistMutation(tx, stored, providers, aliases, next.providerModels, next.aliases);
    const revision = state.revision + 1n;
    const refreshEpoch = write.applyImmediately ? state.refreshEpoch + 1n : state.refreshEpoch;
    await tx.update(modelConfigState).set({ revision, refreshEpoch, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { revision: revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export async function upsertProvider(provider: ModelProviderWriteInput, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'upsertProvider', provider });
}

export async function deleteProvider(id: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'deleteProvider', id });
}

export async function upsertAlias(alias: ModelAliasInput, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'upsertAlias', alias });
}

export async function deleteAlias(alias: string, write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return writeModelConfig(write, { kind: 'deleteAlias', alias });
}

export type ProviderModelWriteResult = ModelConfigVersion & { id: string };

/**
 * 登记提供商模型：ID 由服务端雪花发号，providerId / upstreamModelName 从此不可变。
 * 发号在配置事务外完成，失败只浪费一个号，不影响唯一性；并发重名由唯一索引兑现 409。
 */
export async function createProviderModel(model: ProviderModelInput, write: ModelConfigWrite): Promise<ProviderModelWriteResult> {
  const input = providerModelInputSchema.parse(model);
  const id = (await nextSnowflakeId()).toString();
  try {
    const version = await writeModelConfig(write, { kind: 'createProviderModel', id, model: input });
    return { ...version, id };
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new BusinessError(409, 40904, `提供商 ${input.providerId} 下已有请求模型 ${input.upstreamModelName}，不能重复登记`);
    }
    throw error;
  }
}

/** 更新展示名、能力与兼容声明；提供商与上游请求名不在可编辑范围。 */
export async function updateProviderModel(id: string, update: ProviderModelUpdate, write: ModelConfigWrite): Promise<ProviderModelWriteResult> {
  const parsedId = providerModelIdSchema.parse(id);
  const input = providerModelUpdateSchema.parse(update);
  const version = await writeModelConfig(write, { kind: 'updateProviderModel', id: parsedId, update: input });
  return { ...version, id: parsedId };
}

export async function applyModelConfig(write: ModelConfigWrite): Promise<ModelConfigVersion> {
  return db().transaction(async tx => {
    const state = await lockState(tx);
    assertRevision(state.revision, write.expectedRevision);
    assertValid(await readProviderRows(tx), await readAliasRows(tx));
    const refreshEpoch = state.refreshEpoch + 1n;
    await tx.update(modelConfigState).set({ refreshEpoch, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { revision: state.revision.toString(), refreshEpoch: refreshEpoch.toString() };
  });
}

export type ModelInitializationResult = { initialized: boolean; revision: string; refreshEpoch: string; providerId: string | null };

export async function initializeModelConfigFromEnv(): Promise<ModelInitializationResult> {
  const config = getConfig();
  return db().transaction(async tx => {
    const state = await lockState(tx);
    const providers = await readProviderRows(tx);
    const aliases = await readAliasRows(tx);
    if (providers.length || aliases.length) {
      return { initialized: false, revision: state.revision.toString(), refreshEpoch: state.refreshEpoch.toString(), providerId: null };
    }
    if (state.revision !== 0n || state.refreshEpoch !== 0n) {
      throw new BusinessError(409, 40903, '模型配置状态不一致：版本非零但配置为空，请人工确认后再初始化');
    }
    if (!config.aiModel) throw new BusinessError(400, 40000, 'AI_MODEL 为空，无法从环境变量初始化模型配置');
    const provider = modelProviderInputSchema.parse({
      id: defaultModelProviderId,
      displayName: '环境默认提供商',
      apiFormat: 'openai-chat',
      baseUrl: config.aiBaseUrl,
      apiKeySource: 'env',
      apiKeyEnv: baseModelApiKeyEnv,
      options: {},
      enabled: true,
    });
    const requiredSlots = modelSlots.filter(slot => !slot.optional);
    // 一个模型要同时满足所有必需槽位：能力取各槽位要求的并集，与旧初始化按槽位推断的语义一致。
    const capabilities = requiredSlots.reduce((merged, slot) => {
      const required = capabilitiesForSlot(slot);
      return {
        streaming: merged.streaming || required.streaming,
        toolCalling: merged.toolCalling || required.toolCalling,
        structuredOutput: merged.structuredOutput || required.structuredOutput,
        imageInput: merged.imageInput || required.imageInput,
      };
    }, { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false });
    const modelInput = providerModelInputSchema.parse({
      providerId: defaultModelProviderId,
      upstreamModelName: config.aiModel,
      displayName: `环境默认提供商 / ${config.aiModel}`.slice(0, 128),
      capabilities,
      compatibility: { reasoningContentPassthrough: false },
      enabled: true,
    });
    const providerModelId = await nextSnowflakeIdInTransaction(tx);
    const aliasesToCreate = requiredSlots.map(slot => modelAliasInputSchema.parse({
      alias: slot.slot,
      providerModelId: providerModelId.toString(),
      providerId: defaultModelProviderId,
      modelName: config.aiModel,
      capabilities,
      settings: {},
      enabled: true,
    }));
    assertValid([provider], aliasesToCreate);
    await upsertProviderRow(tx, provider, undefined);
    const timestamp = now();
    await tx.insert(providerModels).values({
      id: providerModelId,
      providerId: modelInput.providerId,
      upstreamModelName: modelInput.upstreamModelName,
      displayName: modelInput.displayName,
      capabilities: modelInput.capabilities,
      compatibility: modelInput.compatibility,
      enabled: modelInput.enabled ? 1 : 0,
      createTime: timestamp,
      updateTime: timestamp,
    });
    for (const alias of aliasesToCreate) await upsertAliasRow(tx, alias, undefined);
    const revision = state.revision + 1n;
    await tx.update(modelConfigState).set({ revision, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
    return { initialized: true, revision: revision.toString(), refreshEpoch: state.refreshEpoch.toString(), providerId: defaultModelProviderId };
  });
}
