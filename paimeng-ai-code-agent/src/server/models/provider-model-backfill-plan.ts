import type { ModelAliasCapabilities, ProviderModelCompatibility } from '@/shared/model-config';

/**
 * 回填计划的纯函数部分：只读输入、只产出计划，不碰数据库。
 * 冲突不吞：同一 (providerId, 请求模型名) 下能力或兼容声明不一致时只报告，不取并集、不任挑一条。
 */

export type BackfillProviderRow = { id: string; displayName: string; enabled: boolean };

export type BackfillModelRow = {
  id: string;
  providerId: string;
  upstreamModelName: string;
  displayName: string;
  capabilities: ModelAliasCapabilities;
  compatibility: ProviderModelCompatibility;
  enabled: boolean;
};

export type BackfillAliasRow = {
  alias: string;
  providerId: string;
  modelName: string;
  capabilities: ModelAliasCapabilities;
  reasoningContentPassthrough: boolean;
  enabled: boolean;
  providerModelId: string | null;
};

export type BackfillRateRow = {
  providerId: string;
  modelName: string;
  providerModelId: string | null;
  effectiveFrom: string;
};

export type BackfillStepRow = { providerId: string | null; modelName: string | null; steps: number };

export type BackfillState = { revision: string; refreshEpoch: string };

export type BackfillConflictReason =
  | 'capabilities-differ'
  | 'compatibility-differ'
  | 'model-capabilities-differ'
  | 'model-compatibility-differ'
  | 'model-disabled'
  | 'provider-disabled'
  | 'alias-linked-elsewhere';

export type BackfillConflict = {
  providerId: string;
  upstreamModelName: string;
  reasons: BackfillConflictReason[];
  aliases: string[];
};

export type BackfillGroupAction = 'create' | 'link' | 'noop' | 'conflict';

export type BackfillGroup = {
  providerId: string;
  upstreamModelName: string;
  displayName: string;
  action: BackfillGroupAction;
  existingModelId: string | null;
  enabled: boolean;
  capabilities: ModelAliasCapabilities;
  compatibility: ProviderModelCompatibility;
  aliasNames: string[];
  aliasesToLink: string[];
  conflicts: BackfillConflictReason[];
};

export type BackfillRateGroup = {
  providerId: string;
  modelName: string;
  versions: number;
  effectiveFroms: string[];
  targetModelId: string | null;
  planned: boolean;
};

export type BackfillRateMismatch = { providerId: string; modelName: string; providerModelId: string };

export type BackfillReport = {
  state: BackfillState;
  expectedRevision: string;
  providers: BackfillProviderRow[];
  models: BackfillModelRow[];
  groups: BackfillGroup[];
  conflicts: BackfillConflict[];
  rates: {
    linkable: BackfillRateGroup[];
    orphans: { providerId: string; modelName: string; versions: number; reason: 'no-model' | 'conflict' }[];
    mismatched: BackfillRateMismatch[];
    alreadyLinked: number;
  };
  steps: { unlinkedModelSteps: number; keys: BackfillStepRow[] };
  aliases: { total: number; linked: number; unlinked: number };
  counts: { modelsToCreate: number; aliasesToLink: number; ratesToLink: number; conflicts: number };
};

export type BackfillInput = {
  state: BackfillState;
  providers: BackfillProviderRow[];
  models: BackfillModelRow[];
  aliases: BackfillAliasRow[];
  rates: BackfillRateRow[];
  steps: BackfillStepRow[];
};

export function backfillGroupKey(providerId: string, upstreamModelName: string): string {
  return `${providerId}\u0000${upstreamModelName}`;
}

export function sameBackfillCapabilities(left: ModelAliasCapabilities, right: ModelAliasCapabilities): boolean {
  return left.streaming === right.streaming
    && left.toolCalling === right.toolCalling
    && left.structuredOutput === right.structuredOutput
    && left.imageInput === right.imageInput;
}

export function sameBackfillCompatibility(left: ProviderModelCompatibility, right: ProviderModelCompatibility): boolean {
  return left.reasoningContentPassthrough === right.reasoningContentPassthrough;
}

/** 与 rate-card DTO 一致：Postgres 在毫秒为 0 时省略 `.000`，报告统一补齐。 */
function fixedMillis(timestamp: string): string {
  return timestamp.length === 19 ? `${timestamp}.000` : timestamp;
}

function capabilitiesKey(capabilities: ModelAliasCapabilities): string {
  return [capabilities.streaming, capabilities.toolCalling, capabilities.structuredOutput, capabilities.imageInput].join('|');
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function displayNameOf(provider: BackfillProviderRow | undefined, providerId: string, upstreamModelName: string): string {
  return `${provider?.displayName ?? providerId} / ${upstreamModelName}`.slice(0, 128);
}

type AliasGroup = { providerId: string; upstreamModelName: string; aliases: BackfillAliasRow[] };

export function buildProviderModelBackfillPlan(input: BackfillInput): BackfillReport {
  const providers = [...input.providers].sort((left, right) => left.id.localeCompare(right.id));
  const models = [...input.models].sort((left, right) => left.id.localeCompare(right.id));
  const providerById = new Map(providers.map(provider => [provider.id, provider]));
  const modelByKey = new Map(models.map(model => [backfillGroupKey(model.providerId, model.upstreamModelName), model]));
  const modelById = new Map(models.map(model => [model.id, model]));

  const grouped = new Map<string, AliasGroup>();
  for (const alias of input.aliases) {
    const key = backfillGroupKey(alias.providerId, alias.modelName);
    const group = grouped.get(key);
    if (group) group.aliases.push(alias);
    else grouped.set(key, { providerId: alias.providerId, upstreamModelName: alias.modelName, aliases: [alias] });
  }

  const groups: BackfillGroup[] = [];
  const conflicts: BackfillConflict[] = [];
  for (const group of [...grouped.values()].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) || left.upstreamModelName.localeCompare(right.upstreamModelName))) {
    const key = backfillGroupKey(group.providerId, group.upstreamModelName);
    const existing = modelByKey.get(key) ?? null;
    const aliasNames = group.aliases.map(alias => alias.alias).sort();
    const unlinked = group.aliases.filter(alias => alias.providerModelId === null);
    const capabilityVariants = uniqueValues(group.aliases.map(alias => capabilitiesKey(alias.capabilities)));
    const compatibilityVariants = uniqueValues(group.aliases.map(alias => String(alias.reasoningContentPassthrough)));
    const reasons: BackfillConflictReason[] = [];
    if (capabilityVariants.length > 1) reasons.push('capabilities-differ');
    if (compatibilityVariants.length > 1) reasons.push('compatibility-differ');

    const capabilities = group.aliases[0].capabilities;
    const compatibility = { reasoningContentPassthrough: group.aliases[0].reasoningContentPassthrough };
    const provider = providerById.get(group.providerId);
    if (provider && !provider.enabled && group.aliases.some(alias => alias.enabled)) reasons.push('provider-disabled');
    if (existing && !sameBackfillCapabilities(existing.capabilities, capabilities)) reasons.push('model-capabilities-differ');
    if (existing && !sameBackfillCompatibility(existing.compatibility, compatibility)) reasons.push('model-compatibility-differ');
    if (existing && !existing.enabled && group.aliases.some(alias => alias.enabled)) reasons.push('model-disabled');
    for (const alias of group.aliases) {
      if (alias.providerModelId === null) continue;
      const linkedModel = modelById.get(alias.providerModelId);
      if (!linkedModel || linkedModel.providerId !== group.providerId || linkedModel.upstreamModelName !== group.upstreamModelName) {
        reasons.push('alias-linked-elsewhere');
        break;
      }
    }

    const uniqueReasons = uniqueValues(reasons) as BackfillConflictReason[];
    const conflict = uniqueReasons.length > 0;
    if (conflict) {
      conflicts.push({ providerId: group.providerId, upstreamModelName: group.upstreamModelName, reasons: uniqueReasons, aliases: aliasNames });
    }
    groups.push({
      providerId: group.providerId,
      upstreamModelName: group.upstreamModelName,
      displayName: existing?.displayName ?? displayNameOf(providerById.get(group.providerId), group.providerId, group.upstreamModelName),
      action: conflict
        ? 'conflict'
        : existing && unlinked.length
          ? 'link'
          : existing
            ? 'noop'
            : unlinked.length
              ? 'create'
              : 'noop',
      existingModelId: existing?.id ?? null,
      enabled: existing?.enabled ?? group.aliases.some(alias => alias.enabled),
      capabilities,
      compatibility,
      aliasNames,
      aliasesToLink: conflict ? [] : unlinked.map(alias => alias.alias).sort(),
      conflicts: uniqueReasons,
    });
  }

  const rateGroups = new Map<string, { providerId: string; modelName: string; rows: BackfillRateRow[] }>();
  let alreadyLinked = 0;
  const mismatched: BackfillRateMismatch[] = [];
  for (const rate of input.rates) {
    if (rate.providerModelId !== null) {
      const linked = modelById.get(rate.providerModelId);
      if (!linked || linked.providerId !== rate.providerId || linked.upstreamModelName !== rate.modelName) {
        mismatched.push({ providerId: rate.providerId, modelName: rate.modelName, providerModelId: rate.providerModelId });
      } else {
        alreadyLinked += 1;
      }
      continue;
    }
    const key = backfillGroupKey(rate.providerId, rate.modelName);
    const group = rateGroups.get(key);
    if (group) group.rows.push(rate);
    else rateGroups.set(key, { providerId: rate.providerId, modelName: rate.modelName, rows: [rate] });
  }
  const groupByKey = new Map(groups.map(group => [backfillGroupKey(group.providerId, group.upstreamModelName), group]));
  const linkable: BackfillRateGroup[] = [];
  const rateOrphans: BackfillReport['rates']['orphans'] = [];
  for (const rateGroup of [...rateGroups.values()].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) || left.modelName.localeCompare(right.modelName))) {
    const key = backfillGroupKey(rateGroup.providerId, rateGroup.modelName);
    const group = groupByKey.get(key);
    const model = modelByKey.get(key);
    if (group?.action === 'conflict') {
      rateOrphans.push({ providerId: rateGroup.providerId, modelName: rateGroup.modelName, versions: rateGroup.rows.length, reason: 'conflict' });
      continue;
    }
    if (!group && !model) {
      rateOrphans.push({ providerId: rateGroup.providerId, modelName: rateGroup.modelName, versions: rateGroup.rows.length, reason: 'no-model' });
      continue;
    }
    linkable.push({
      providerId: rateGroup.providerId,
      modelName: rateGroup.modelName,
      versions: rateGroup.rows.length,
      effectiveFroms: rateGroup.rows.map(row => fixedMillis(row.effectiveFrom)).sort(),
      targetModelId: model?.id ?? null,
      planned: !model,
    });
  }

  const steps = [...input.steps]
    .sort((left, right) => (left.providerId ?? '').localeCompare(right.providerId ?? '') || (left.modelName ?? '').localeCompare(right.modelName ?? ''));
  const stepsTotal = steps.reduce((sum, step) => sum + step.steps, 0);
  const aliases = {
    total: input.aliases.length,
    linked: input.aliases.filter(alias => alias.providerModelId !== null).length,
    unlinked: input.aliases.filter(alias => alias.providerModelId === null).length,
  };

  return {
    state: input.state,
    expectedRevision: input.state.revision,
    providers,
    models,
    groups,
    conflicts,
    rates: { linkable, orphans: rateOrphans, mismatched, alreadyLinked },
    steps: { unlinkedModelSteps: stepsTotal, keys: steps },
    aliases,
    counts: {
      modelsToCreate: groups.filter(group => group.action === 'create').length,
      aliasesToLink: groups.reduce((sum, group) => sum + group.aliasesToLink.length, 0),
      ratesToLink: linkable.reduce((sum, group) => sum + group.versions, 0),
      conflicts: conflicts.length,
    },
  };
}
