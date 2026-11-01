import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, now, type Transaction } from '../infra/db';
import { BusinessError } from '../infra/http';
import { creditRateCard, generationSteps, modelAliases, modelConfigState, modelProviders, providerModels } from '../infra/schema';
import { nextSnowflakeIdInTransaction } from '../infra/snowflake';
import { aliasCapabilitiesSchema, aliasSettingsSchema, modelConfigStateId, providerModelInputSchema } from '@/shared/model-config';
import { assertModelConfigRevision } from './store';
import {
  backfillGroupKey,
  buildProviderModelBackfillPlan,
  sameBackfillCapabilities,
  sameBackfillCompatibility,
  type BackfillAliasRow,
  type BackfillInput,
  type BackfillModelRow,
  type BackfillRateRow,
  type BackfillReport,
  type BackfillStepRow,
} from './provider-model-backfill-plan';

/**
 * 一次性回填：把现有槽位与费率关联到 `provider_model` 身份。
 *
 * 安全边界（docs/plans/provider-model-billing.md「历史数据迁移」）：
 * - 默认 dry-run；`applyProviderModelBackfill` 才写库，且整批在一个事务里完成。
 * - 同名跨提供商、大小写、# 后缀都不做猜测；费率只在 (provider_id, model_name) 精确对应时关联。
 * - 冲突不吞：能力或兼容声明不一致时整批中止，不取并集、不任挑一条。
 * - 只动 provider_model / model_alias.provider_model_id / credit_rate_card.provider_model_id。
 *   不碰 generation_step、账单快照、entry、余额与任何结算路径。
 */

export type BackfillApplyResult = {
  plan: BackfillReport;
  createdModels: number;
  linkedAliases: number;
  linkedRates: number;
  revision: string;
  refreshEpoch: string;
  changed: boolean;
};

async function readBackfillInput(tx: Transaction): Promise<BackfillInput> {
  const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1);
  if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');

  const providerRows = await tx.select({ id: modelProviders.id, displayName: modelProviders.displayName, enabled: modelProviders.enabled }).from(modelProviders);
  const modelRows = await tx.select().from(providerModels);
  const aliasRows = await tx
    .select({
      alias: modelAliases.alias,
      providerId: modelAliases.providerId,
      modelName: modelAliases.modelName,
      capabilities: modelAliases.capabilities,
      settings: modelAliases.settings,
      enabled: modelAliases.enabled,
      providerModelId: modelAliases.providerModelId,
    })
    .from(modelAliases);
  const rateRows = await tx
    .select({
      providerId: creditRateCard.providerId,
      modelName: creditRateCard.modelName,
      providerModelId: creditRateCard.providerModelId,
      effectiveFrom: creditRateCard.effectiveFrom,
    })
    .from(creditRateCard);
  const stepRows = await tx
    .select({
      providerId: generationSteps.providerId,
      modelName: generationSteps.modelName,
      steps: sql<number>`count(*)::int`,
    })
    .from(generationSteps)
    .where(and(eq(generationSteps.kind, 'model'), isNull(generationSteps.providerModelId)))
    .groupBy(generationSteps.providerId, generationSteps.modelName);

  return {
    state: { revision: state.revision.toString(), refreshEpoch: state.refreshEpoch.toString() },
    providers: providerRows.map(row => ({ id: row.id, displayName: row.displayName, enabled: row.enabled === 1 })),
    models: modelRows.map(row => {
      const parsed = providerModelInputSchema.parse({
        providerId: row.providerId,
        upstreamModelName: row.upstreamModelName,
        displayName: row.displayName,
        capabilities: row.capabilities,
        compatibility: row.compatibility,
        enabled: row.enabled === 1,
      });
      return { id: row.id.toString(), ...parsed } satisfies BackfillModelRow;
    }),
    aliases: aliasRows.map(row => ({
      alias: row.alias,
      providerId: row.providerId,
      modelName: row.modelName,
      capabilities: aliasCapabilitiesSchema.parse(row.capabilities),
      reasoningContentPassthrough: aliasSettingsSchema.parse(row.settings).reasoningContentPassthrough ?? false,
      enabled: row.enabled === 1,
      providerModelId: row.providerModelId === null ? null : row.providerModelId.toString(),
    })) satisfies BackfillAliasRow[],
    rates: rateRows.map(row => ({
      providerId: row.providerId,
      modelName: row.modelName,
      providerModelId: row.providerModelId === null ? null : row.providerModelId.toString(),
      effectiveFrom: row.effectiveFrom,
    })) satisfies BackfillRateRow[],
    steps: stepRows.map(row => ({ providerId: row.providerId, modelName: row.modelName, steps: Number(row.steps) })) satisfies BackfillStepRow[],
  };
}

/** 只读预检：与 apply 使用同一份纯计划函数，默认零写入。 */
export async function planProviderModelBackfill(): Promise<BackfillReport> {
  return db().transaction(
    async tx => buildProviderModelBackfillPlan(await readBackfillInput(tx)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * 受控回填：锁住配置状态行、校验 dry-run 版本，再在同一事务里重读并应用。
 * 预检后配置若已变化，版本不一致直接中止；重复执行只处理仍未关联的行。
 */
export async function applyProviderModelBackfill(expectedRevision: string): Promise<BackfillApplyResult> {
  return db().transaction(async tx => {
    const [state] = await tx.select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)).limit(1).for('update');
    if (!state) throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
    assertModelConfigRevision(state.revision, expectedRevision);

    const plan = buildProviderModelBackfillPlan(await readBackfillInput(tx));
    if (plan.conflicts.length) {
      throw new BusinessError(409, 40905, `存在 ${plan.conflicts.length} 组能力/兼容声明冲突，未写入任何变更；请先确认后重跑预检`);
    }

    const modelIds = new Map(plan.models.map(model => [backfillGroupKey(model.providerId, model.upstreamModelName), model.id]));
    let createdModels = 0;
    for (const group of plan.groups) {
      if (group.action !== 'create') continue;
      const timestamp = now();
      const [inserted] = await tx
        .insert(providerModels)
        .values({
          id: await nextSnowflakeIdInTransaction(tx),
          providerId: group.providerId,
          upstreamModelName: group.upstreamModelName,
          displayName: group.displayName,
          capabilities: group.capabilities,
          compatibility: group.compatibility,
          enabled: group.enabled ? 1 : 0,
          createTime: timestamp,
          updateTime: timestamp,
        })
        .onConflictDoNothing({ target: [providerModels.providerId, providerModels.upstreamModelName] })
        .returning({ id: providerModels.id });
      if (inserted) {
        createdModels += 1;
        modelIds.set(backfillGroupKey(group.providerId, group.upstreamModelName), inserted.id.toString());
        continue;
      }
      // 并发的外部写入抢先登记了同一请求名：复用它的身份，但先确认能力/兼容声明仍与计划一致。
      const [existing] = await tx
        .select()
        .from(providerModels)
        .where(and(eq(providerModels.providerId, group.providerId), eq(providerModels.upstreamModelName, group.upstreamModelName)))
        .limit(1);
      if (!existing) throw new Error(`提供商模型 ${group.providerId}/${group.upstreamModelName} 登记失败`);
      if (!sameBackfillCapabilities(existing.capabilities, group.capabilities)
        || !sameBackfillCompatibility(existing.compatibility, group.compatibility)) {
        throw new BusinessError(409, 40905, `提供商模型 ${group.providerId}/${group.upstreamModelName} 已被并发写入为不同能力，请重新预检`);
      }
      modelIds.set(backfillGroupKey(group.providerId, group.upstreamModelName), existing.id.toString());
    }

    let linkedAliases = 0;
    for (const group of plan.groups) {
      if (!group.aliasesToLink.length) continue;
      const id = modelIds.get(backfillGroupKey(group.providerId, group.upstreamModelName));
      if (!id) throw new Error(`槽位组 ${group.providerId}/${group.upstreamModelName} 缺少目标模型 ID`);
      const updated = await tx
        .update(modelAliases)
        .set({ providerModelId: BigInt(id), updateTime: now() })
        .where(and(
          inArray(modelAliases.alias, group.aliasesToLink),
          eq(modelAliases.providerId, group.providerId),
          eq(modelAliases.modelName, group.upstreamModelName),
          isNull(modelAliases.providerModelId),
        ))
        .returning({ alias: modelAliases.alias });
      linkedAliases += updated.length;
    }

    let linkedRates = 0;
    for (const rate of plan.rates.linkable) {
      const id = rate.targetModelId ?? modelIds.get(backfillGroupKey(rate.providerId, rate.modelName));
      if (!id) throw new Error(`费率组 ${rate.providerId}/${rate.modelName} 缺少目标模型 ID`);
      const updated = await tx
        .update(creditRateCard)
        .set({ providerModelId: BigInt(id) })
        .where(and(
          eq(creditRateCard.providerId, rate.providerId),
          eq(creditRateCard.modelName, rate.modelName),
          inArray(creditRateCard.effectiveFrom, rate.effectiveFroms),
          isNull(creditRateCard.providerModelId),
        ))
        .returning({ effectiveFrom: creditRateCard.effectiveFrom });
      linkedRates += updated.length;
    }

    let revision = state.revision.toString();
    let refreshEpoch = state.refreshEpoch.toString();
    if (createdModels > 0 || linkedAliases > 0) {
      const nextRevision = state.revision + 1n;
      const nextEpoch = state.refreshEpoch + 1n;
      await tx.update(modelConfigState).set({ revision: nextRevision, refreshEpoch: nextEpoch, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));
      revision = nextRevision.toString();
      refreshEpoch = nextEpoch.toString();
    }

    return {
      plan,
      createdModels,
      linkedAliases,
      linkedRates,
      revision,
      refreshEpoch,
      changed: createdModels + linkedAliases + linkedRates > 0,
    };
  });
}
