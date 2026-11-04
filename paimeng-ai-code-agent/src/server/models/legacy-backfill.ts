import { createHash } from 'node:crypto';
import {
  modelAliasInputSchema,
  modelSlotOf,
  requiredModelAliases,
} from '../../shared/model-config';
import {
  emptyModelConfigDocument,
  legacyPriceSchema,
  modelConfigDocumentSchema,
  modelConfigProviderSchema,
  modelPriceVersionSchema,
  type ModelConfigDocument,
  type ModelConfigProvider,
  type ProviderModel,
} from '../../shared/model-document';
import type {
  creditRateCard,
  modelAliases,
  modelConfigState,
  modelProviders,
} from '../infra/schema';

export type LegacyBackfillInput = {
  providers: readonly (typeof modelProviders.$inferSelect)[];
  aliases: readonly (typeof modelAliases.$inferSelect)[];
  state: typeof modelConfigState.$inferSelect | null;
  rateCards: readonly (typeof creditRateCard.$inferSelect)[];
};

/** Diagnostics contain row positions and fixed messages only, never configuration values. */
export type LegacyBackfillReport = {
  counts: {
    providers: number;
    models: number;
    slots: number;
    priceVersions: number;
    orphans: number;
    conflicts: number;
  };
  documentBytes: number;
  orphanRows: number[];
  conflictMessages: string[];
};

export class LegacyBackfillConflictError extends Error {
  constructor(readonly report: LegacyBackfillReport) {
    super(
      `Legacy model configuration has ${report.counts.conflicts} conflict(s): ${report.conflictMessages.join('; ')}`,
    );
    this.name = 'LegacyBackfillConflictError';
  }
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const modelKey = (providerId: string, upstream: string) => `${providerId}\u0000${upstream}`;
const instantOf = (timestamp: string) => Date.parse(`${timestamp.replace(' ', 'T')}Z`);

/** Pure conversion: no clock, environment, database access, or secret decryption. */
export function backfillLegacyModelConfig(input: LegacyBackfillInput): {
  document: ModelConfigDocument;
  report: LegacyBackfillReport;
  version: { revision: string; refreshEpoch: string };
} {
  const report: LegacyBackfillReport = {
    counts: { providers: 0, models: 0, slots: 0, priceVersions: 0, orphans: 0, conflicts: 0 },
    documentBytes: 0,
    orphanRows: [],
    conflictMessages: [],
  };
  const conflict = (message: string) => {
    report.conflictMessages.push(message);
    report.counts.conflicts++;
  };
  const document = emptyModelConfigDocument();
  const providers = new Map<string, ModelConfigProvider>();
  const models = new Map<string, { model: ProviderModel; aliasRow: number }>();
  const modelIds = new Set<string>();
  const seenAliases = new Set<string>();

  input.providers.forEach((row, index) => {
    if ((row.apiKeyEnv === null) === (row.apiKeyCiphertext === null)) {
      conflict(`providers[${index}]: exactly one API key source is required`);
      return;
    }
    if (row.enabled !== 0 && row.enabled !== 1) {
      conflict(`providers[${index}]: enabled must be 0 or 1`);
      return;
    }
    const parsed = modelConfigProviderSchema.safeParse({
      id: row.id,
      displayName: row.displayName,
      apiFormat: row.apiFormat,
      baseUrl: row.baseUrl,
      apiKey:
        row.apiKeyEnv !== null
          ? { source: 'env', env: row.apiKeyEnv }
          : { source: 'inline', ciphertext: row.apiKeyCiphertext },
      options: row.options,
      headers: row.headers ?? {},
      enabled: row.enabled === 1,
      models: [],
      createTime: row.createTime,
      updateTime: row.updateTime,
    });
    if (!parsed.success) {
      // Zod messages can contain input-derived header names or enum values. Do not print them.
      conflict(`providers[${index}]: invalid provider fields`);
      return;
    }
    if (providers.has(parsed.data.id)) {
      conflict(`providers[${index}]: duplicate provider ID`);
      return;
    }
    providers.set(parsed.data.id, parsed.data);
  });
  document.providers = [...providers.values()].sort((left, right) => compare(left.id, right.id));
  report.counts.providers = document.providers.length;

  // Sort aliases so the selected model timestamps and document order never depend on query order.
  const aliases = input.aliases
    .map((row, index) => ({ row, index }))
    .sort((left, right) => compare(left.row.alias, right.row.alias));
  for (const { row, index } of aliases) {
    if (row.enabled !== 0 && row.enabled !== 1) {
      conflict(`aliases[${index}]: enabled must be 0 or 1`);
      continue;
    }
    const parsed = modelAliasInputSchema.safeParse({
      alias: row.alias,
      providerId: row.providerId,
      modelName: row.modelName,
      capabilities: row.capabilities,
      settings: row.settings,
      enabled: row.enabled === 1,
    });
    if (!parsed.success || row.modelName !== row.modelName.trim()) {
      conflict(`aliases[${index}]: invalid alias fields`);
      continue;
    }
    const alias = parsed.data;
    const slot = modelSlotOf(alias.alias);
    if (!slot) {
      conflict(`aliases[${index}]: unknown slot`);
      continue;
    }
    if (seenAliases.has(alias.alias)) {
      conflict(`aliases[${index}]: duplicate alias`);
      continue;
    }
    seenAliases.add(alias.alias);
    if (!alias.enabled && !slot.optional) conflict(`aliases[${index}]: required alias is disabled`);
    const provider = providers.get(alias.providerId);
    if (!provider) {
      conflict(`aliases[${index}]: provider is missing or invalid`);
      continue;
    }
    const key = modelKey(alias.providerId, alias.modelName);
    let found = models.get(key);
    if (found) {
      if (JSON.stringify(found.model.capabilities) !== JSON.stringify(alias.capabilities)) {
        conflict(
          `aliases[${index}]: capabilities conflict with aliases[${found.aliasRow}] for the same provider and upstream model`,
        );
      }
      found.model.createTime = [found.model.createTime, row.createTime].sort(compare)[0];
      found.model.updateTime = [found.model.updateTime, row.updateTime].sort(compare)[1];
    } else {
      const id = `pm_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
      if (modelIds.has(id)) conflict(`aliases[${index}]: deterministic model ID collision`);
      modelIds.add(id);
      const model: ProviderModel = {
        id,
        upstream: alias.modelName,
        displayName: alias.modelName,
        enabled: true,
        capabilities: alias.capabilities,
        upstreamPrice: null,
        prices: [],
        createTime: row.createTime,
        updateTime: row.updateTime,
      };
      found = { model, aliasRow: index };
      models.set(key, found);
      provider.models.push(model);
    }
    if (alias.enabled)
      document.slots.push({ slot: alias.alias, modelId: found.model.id, settings: alias.settings });
  }
  for (const slot of requiredModelAliases) {
    if (!seenAliases.has(slot)) conflict(`required alias is missing: ${slot}`);
  }
  for (const provider of document.providers)
    provider.models.sort((left, right) => compare(left.upstream, right.upstream));
  report.counts.models = models.size;
  report.counts.slots = document.slots.length;

  const rates = input.rateCards
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        compare(left.row.providerId, right.row.providerId) ||
        compare(left.row.modelName, right.row.modelName) ||
        instantOf(left.row.effectiveFrom) - instantOf(right.row.effectiveFrom),
    );
  const rateKeys = new Set<string>();
  for (const { row, index } of rates) {
    const parsed = legacyPriceSchema.safeParse({
      ...row,
      createdBy: row.createdBy?.toString() ?? null,
    });
    if (!parsed.success || Number.isNaN(instantOf(row.effectiveFrom))) {
      conflict(`rateCards[${index}]: invalid legacy rate fields or effective time`);
      continue;
    }
    const key = modelKey(row.providerId, row.modelName);
    const rateKey = `${key}\u0000${instantOf(row.effectiveFrom)}`;
    if (rateKeys.has(rateKey)) {
      conflict(
        `rateCards[${index}]: duplicate effective time for the same provider and upstream model`,
      );
      continue;
    }
    rateKeys.add(rateKey);
    const found = models.get(key);
    if (!found) {
      document.legacyPrices.push(parsed.data);
      report.orphanRows.push(index);
      report.counts.orphans++;
      continue;
    }
    const price = modelPriceVersionSchema.safeParse({
      version: found.model.prices.length + 1,
      effectiveAt: row.effectiveFrom,
      currency: 'CNY',
      inputMissFen: row.creditInputMiss,
      inputHitFen: row.creditInputHit,
      outputFen: row.creditOutput,
      upstreamUsd: {
        inputMiss: row.usdInputMiss,
        inputHit: row.usdInputHit,
        output: row.usdOutput,
      },
      costBasis: row.costBasis,
      costSource: row.costSource,
      note: row.note,
    });
    if (!price.success) {
      conflict(`rateCards[${index}]: rate cannot be represented as a model price version`);
      continue;
    }
    found.model.prices.push(price.data);
    report.counts.priceVersions++;
  }

  const state = input.state;
  if (
    !state ||
    state.id !== 'models' ||
    !/^\d+$/u.test(state.revision.toString()) ||
    !/^\d+$/u.test(state.refreshEpoch.toString())
  ) {
    conflict('state: missing or invalid models revision/refresh epoch');
  }
  const parsed = modelConfigDocumentSchema.safeParse(document);
  if (!parsed.success)
    conflict('document: converted configuration exceeds schema limits or contains invalid fields');
  if (report.counts.conflicts) throw new LegacyBackfillConflictError(report);
  if (!parsed.success || !state) throw new Error('Legacy backfill validation invariant failed');
  report.documentBytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
  return {
    document: parsed.data,
    report,
    version: { revision: state.revision.toString(), refreshEpoch: state.refreshEpoch.toString() },
  };
}
