import { eq } from 'drizzle-orm';
import { db, now } from '@/server/infra/db';
import { appConfig } from '@/server/infra/schema';
import {
  emptyModelConfigDocument,
  modelConfigDocumentSchema,
  modelConfigKey,
  type ModelConfigDocument,
  type ProviderModel,
} from '@/shared/model-document';
import type { ModelAliasInput } from '@/shared/model-config';

/** 集成测试直接改 JSON 文档：只用于模拟损坏/停用/缺失等状态，生产写入仍走 mutateModelConfig。 */
export async function resetModelConfigRow(): Promise<void> {
  await db().insert(appConfig).values({
    key: modelConfigKey,
    value: emptyModelConfigDocument(),
    revision: 0n,
    refreshEpoch: 0n,
    updatedAt: now(),
  }).onConflictDoUpdate({
    target: appConfig.key,
    set: { value: emptyModelConfigDocument(), revision: 0n, refreshEpoch: 0n, updatedAt: now() },
  });
}

export async function readTestDocument(): Promise<{ document: ModelConfigDocument; revision: bigint; refreshEpoch: bigint }> {
  const [row] = await db().select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new Error('app_config.model_config 缺失，请先执行迁移');
  return { document: modelConfigDocumentSchema.parse(row.value), revision: row.revision, refreshEpoch: row.refreshEpoch };
}

export async function writeTestDocument(document: ModelConfigDocument, options: { bumpRevision?: boolean; refreshEpoch?: bigint } = {}): Promise<void> {
  const row = await readTestDocument();
  await db().update(appConfig).set({
    value: document,
    revision: options.bumpRevision === false ? row.revision : row.revision + 1n,
    refreshEpoch: options.refreshEpoch ?? row.refreshEpoch,
    updatedAt: now(),
  }).where(eq(appConfig.key, modelConfigKey));
}

export async function patchTestDocument(mutator: (document: ModelConfigDocument) => void): Promise<ModelConfigDocument> {
  const [row] = await db().select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new Error('app_config.model_config 缺失，请先执行迁移');
  // 故意不做 schema 校验：测试需要模拟损坏/未知格式的配置，读取方应 fail-closed。
  const document = row.value as ModelConfigDocument;
  mutator(document);
  await db().update(appConfig).set({ value: document, revision: row.revision + 1n, updatedAt: now() }).where(eq(appConfig.key, modelConfigKey));
  return document;
}

export async function testModelId(providerId: string, upstream: string): Promise<string | null> {
  const { document } = await readTestDocument();
  return document.providers.find(provider => provider.id === providerId)?.models.find(model => model.upstream === upstream)?.id ?? null;
}

/**
 * 把旧「别名」写法映射到新文档：必要时登记模型、补一个 1 分测试价，再写槽位分配。
 * 生成/语音测试只关心解析，不关心账单；需要真实价格的结算测试请显式写价格版本。
 */
export async function upsertTestAlias(alias: ModelAliasInput, options: { applyImmediately?: boolean } = {}): Promise<void> {
  const { document, refreshEpoch } = await readTestDocument();
  const provider = document.providers.find(candidate => candidate.id === alias.providerId);
  if (!provider) throw new Error(`测试别名指向不存在的提供商 ${alias.providerId}`);
  let model = provider.models.find(candidate => candidate.upstream === alias.modelName);
  if (!model) {
    model = {
      id: `pm_test${document.providers.length}${provider.models.length}`,
      upstream: alias.modelName,
      displayName: alias.modelName,
      enabled: true,
      capabilities: alias.capabilities,
      upstreamPrice: null,
      prices: [],
      createTime: now(),
      updateTime: now(),
    } satisfies ProviderModel;
    provider.models.push(model);
  }
  model.capabilities = alias.capabilities;
  model.enabled = alias.enabled;
  if (!model.prices.length) {
    model.prices.push({
      version: 1,
      effectiveAt: '2020-01-01 00:00:00.000',
      currency: 'CNY',
      inputMissFen: 1,
      inputHitFen: 0,
      outputFen: 1,
      upstreamUsd: null,
      note: 'test fixture',
    });
  }
  const assignment = { slot: alias.alias, modelId: model.id, settings: alias.settings };
  const index = document.slots.findIndex(candidate => candidate.slot === alias.alias);
  if (index >= 0) document.slots[index] = assignment;
  else document.slots.push(assignment);
  await writeTestDocument(document, { refreshEpoch: options.applyImmediately ? refreshEpoch + 1n : refreshEpoch });
}
