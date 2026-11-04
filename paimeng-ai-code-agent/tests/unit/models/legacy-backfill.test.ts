import { describe, expect, it } from 'vitest';
import { modelConfigDocumentSchema } from '@/shared/model-document';
import { rateViewOfPrice } from '@/server/billing/rate-card';
import {
  backfillLegacyModelConfig,
  LegacyBackfillConflictError,
  type LegacyBackfillInput,
} from '@/server/models/legacy-backfill';

const time = '2026-10-01 00:00:00.000';
const capabilities = { streaming: true, toolCalling: true, structuredOutput: true };
type ProviderRow = LegacyBackfillInput['providers'][number];
type AliasRow = LegacyBackfillInput['aliases'][number];
type RateRow = LegacyBackfillInput['rateCards'][number];
const provider = (overrides: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'primary',
  displayName: '主提供商',
  apiFormat: 'openai-chat',
  baseUrl: 'https://api.example.test/v1',
  apiKeyEnv: 'AI_API_KEY',
  apiKeyCiphertext: null,
  options: {},
  headers: null,
  enabled: 1,
  createTime: time,
  updateTime: time,
  ...overrides,
});
const alias = (overrides: Partial<AliasRow> = {}): AliasRow => ({
  alias: 'codegen.default',
  providerId: 'primary',
  modelName: 'gpt-test',
  capabilities,
  settings: {},
  enabled: 1,
  createTime: time,
  updateTime: time,
  ...overrides,
});
const rate = (overrides: Partial<RateRow> = {}): RateRow => ({
  providerId: 'primary',
  modelName: 'gpt-test',
  effectiveFrom: time,
  creditInputMiss: 600,
  creditInputHit: 12,
  creditOutput: 2500,
  usdInputMiss: '0.300000',
  usdInputHit: '0.006000',
  usdOutput: '1.200000',
  costBasis: 'peak',
  costSource: 'https://example.test/pricing',
  note: '旧价格说明',
  createdBy: 9007199254740993n,
  createTime: time,
  ...overrides,
});
const input = (overrides: Partial<LegacyBackfillInput> = {}): LegacyBackfillInput => ({
  providers: [provider()],
  aliases: [
    alias(),
    alias({ alias: 'route.classify', settings: { temperature: 0.2, maxOutputTokens: 1000 } }),
  ],
  state: { id: 'models', revision: 9007199254740993n, refreshEpoch: 7n, updateTime: time },
  rateCards: [],
  ...overrides,
});
function conflictOf(rows: LegacyBackfillInput): LegacyBackfillConflictError {
  try {
    backfillLegacyModelConfig(rows);
    throw new Error('Expected backfill conflict');
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyBackfillConflictError);
    return error as LegacyBackfillConflictError;
  }
}

describe('legacy-backfill', () => {
  it('deduplicates provider/upstream pairs with the specified deterministic ID and preserves slot settings', () => {
    const { document, report, version } = backfillLegacyModelConfig(input());
    expect(document.providers[0].models).toEqual([
      {
        id: 'pm_f6f55ed10f2b20df',
        upstream: 'gpt-test',
        displayName: 'gpt-test',
        enabled: true,
        capabilities: { ...capabilities, imageInput: false },
        upstreamPrice: null,
        prices: [],
        createTime: time,
        updateTime: time,
      },
    ]);
    expect(document.providers[0].apiKey).toEqual({ source: 'env', env: 'AI_API_KEY' });
    expect(document.providers[0].headers).toEqual({});
    expect(document.slots).toEqual([
      { slot: 'codegen.default', modelId: 'pm_f6f55ed10f2b20df', settings: {} },
      {
        slot: 'route.classify',
        modelId: 'pm_f6f55ed10f2b20df',
        settings: { temperature: 0.2, maxOutputTokens: 1000 },
      },
    ]);
    expect(version).toEqual({ revision: '9007199254740993', refreshEpoch: '7' });
    expect(report.counts).toEqual({
      providers: 1,
      models: 1,
      slots: 2,
      priceVersions: 0,
      orphans: 0,
      conflicts: 0,
    });
    expect(report.documentBytes).toBe(Buffer.byteLength(JSON.stringify(document), 'utf8'));
    expect(modelConfigDocumentSchema.parse(document)).toEqual(document);
  });

  it('keeps different providers and upstream names as separate models', () => {
    const { document } = backfillLegacyModelConfig(
      input({
        providers: [provider(), provider({ id: 'secondary', enabled: 0 })],
        aliases: [
          ...input().aliases,
          alias({ alias: 'version.summary', providerId: 'secondary' }),
          alias({ alias: 'speech.transcribe', modelName: 'whisper' }),
        ],
      }),
    );
    const models = document.providers.flatMap((item) => item.models);
    expect(new Set(models.map((model) => model.id)).size).toBe(3);
    expect(document.providers[1].enabled).toBe(false);
  });

  it.each([
    { streaming: false, toolCalling: true, structuredOutput: true },
    { ...capabilities, imageInput: true },
  ])('aborts when shared model capabilities differ: %j', (conflicting) => {
    const error = conflictOf(
      input({ aliases: [alias(), alias({ alias: 'route.classify', capabilities: conflicting })] }),
    );
    expect(error.report.counts.conflicts).toBe(1);
    expect(error.message).toContain('capabilities conflict');
  });

  it('normalizes missing imageInput to false before comparing capabilities', () => {
    expect(
      backfillLegacyModelConfig(
        input({
          aliases: [
            alias(),
            alias({
              alias: 'route.classify',
              capabilities: { ...capabilities, imageInput: false },
            }),
          ],
        }),
      ).report.counts.conflicts,
    ).toBe(0);
  });

  it('aborts when a required alias is disabled', () => {
    const error = conflictOf(
      input({ aliases: [alias({ enabled: 0 }), alias({ alias: 'route.classify' })] }),
    );
    expect(error.message).toContain('required alias is disabled');
  });

  it('omits the disabled optional slot while retaining its model and matching prices', () => {
    const { document } = backfillLegacyModelConfig(
      input({
        aliases: [
          ...input().aliases,
          alias({ alias: 'version.summary', modelName: 'summary-only', enabled: 0 }),
        ],
        rateCards: [rate({ modelName: 'summary-only' })],
      }),
    );
    expect(document.slots.map((slot) => slot.slot)).toEqual(['codegen.default', 'route.classify']);
    expect(
      document.providers[0].models.find((model) => model.upstream === 'summary-only'),
    ).toMatchObject({
      enabled: true,
      prices: [{ version: 1, inputMissFen: 600 }],
    });
    expect(document.legacyPrices).toEqual([]);
  });

  it('still checks capability conflicts from disabled optional aliases', () => {
    const error = conflictOf(
      input({
        aliases: [
          ...input().aliases,
          alias({
            alias: 'version.summary',
            enabled: 0,
            capabilities: { ...capabilities, imageInput: true },
          }),
        ],
      }),
    );
    expect(error.message).toContain('capabilities conflict');
  });

  it('attaches chronological price versions and preserves unmatched rows as legacy prices', () => {
    const older = rate();
    const newer = rate({ effectiveFrom: '2026-10-02 00:00:00.000', creditInputMiss: 700 });
    const orphan = rate({ providerId: 'retired', modelName: 'old-model' });
    const { document, report } = backfillLegacyModelConfig(
      input({ rateCards: [newer, orphan, older] }),
    );
    const prices = document.providers[0].models[0].prices;
    expect(prices.map((price) => [price.version, price.effectiveAt, price.inputMissFen])).toEqual([
      [1, time, 600],
      [2, newer.effectiveFrom, 700],
    ]);
    expect(prices[0]).toMatchObject({
      currency: 'CNY',
      inputMissFen: 600,
      inputHitFen: 12,
      outputFen: 2500,
      upstreamUsd: { inputMiss: '0.300000', inputHit: '0.006000', output: '1.200000' },
      costBasis: 'peak',
      costSource: older.costSource,
      note: older.note,
    });
    expect(rateViewOfPrice('primary', 'gpt-test', prices[0])).toMatchObject({
      costBasis: older.costBasis,
      costSource: older.costSource,
      note: older.note,
    });
    expect(document.legacyPrices).toEqual([{ ...orphan, createdBy: '9007199254740993' }]);
    expect(report.counts.priceVersions).toBe(2);
    expect(report.counts.orphans).toBe(1);
    expect(report.orphanRows).toEqual([1]);
  });

  it('keeps unmatched rates separate even when only the provider or model name matches', () => {
    const { document, report } = backfillLegacyModelConfig(
      input({ rateCards: [rate({ providerId: 'other' }), rate({ modelName: 'other' })] }),
    );
    expect(document.providers[0].models[0].prices).toEqual([]);
    expect(document.legacyPrices).toHaveLength(2);
    expect(report.counts.orphans).toBe(2);
  });

  it('produces identical output on repeated runs without mutating input, independent of row ordering', () => {
    const rows = input({
      providers: [provider({ id: 'secondary' }), provider()],
      rateCards: [rate({ effectiveFrom: '2026-10-02 00:00:00.000' }), rate()],
    });
    const before = structuredClone(rows);
    const first = backfillLegacyModelConfig(rows);
    expect(backfillLegacyModelConfig(rows)).toEqual(first);
    expect(
      backfillLegacyModelConfig({
        ...rows,
        providers: [...rows.providers].reverse(),
        aliases: [...rows.aliases].reverse(),
        rateCards: [...rows.rateCards].reverse(),
      }),
    ).toEqual(first);
    expect(rows).toEqual(before);
  });

  it('preserves inline ciphertext in the document without leaking it, headers or URLs into diagnostics', () => {
    const secret = 'DO-NOT-PRINT-secret';
    const rows = input({
      providers: [
        provider({
          apiKeyEnv: null,
          apiKeyCiphertext: secret,
          headers: { 'x-token': secret },
          baseUrl: `https://api.example.test/${secret}`,
        }),
      ],
    });
    const { document, report } = backfillLegacyModelConfig(rows);
    expect(document.providers[0].apiKey).toEqual({ source: 'inline', ciphertext: secret });
    expect(JSON.stringify(report)).not.toContain(secret);
    const capabilityConflict = conflictOf({
      ...rows,
      aliases: [
        ...rows.aliases,
        alias({ alias: 'version.summary', capabilities: { ...capabilities, imageInput: true } }),
      ],
    });
    expect(JSON.stringify(capabilityConflict.report) + capabilityConflict.message).not.toContain(
      secret,
    );
    const invalidProvider = conflictOf({
      ...rows,
      providers: [
        provider({
          apiKeyEnv: null,
          apiKeyCiphertext: secret,
          headers: { [`${secret}\n`]: secret },
        }),
      ],
    });
    expect(JSON.stringify(invalidProvider.report) + invalidProvider.message).not.toContain(secret);
  });

  it('rejects ambiguous API key sources, missing state, unknown slots and missing providers', () => {
    expect(
      conflictOf(input({ providers: [provider({ apiKeyCiphertext: 'ciphertext' })] })).message,
    ).toContain('exactly one API key source');
    expect(conflictOf(input({ state: null })).message).toContain('state: missing or invalid');
    expect(
      conflictOf(input({ aliases: [...input().aliases, alias({ alias: 'unknown.slot' })] }))
        .message,
    ).toContain('unknown slot');
    expect(conflictOf(input({ providers: [] })).message).toContain('provider is missing');
    expect(conflictOf(input({ aliases: [] })).message).toContain('required alias is missing');
  });

  it('aborts on duplicate effective times or rates that cannot fit the target price schema', () => {
    expect(conflictOf(input({ rateCards: [rate(), rate()] })).message).toContain(
      'duplicate effective time',
    );
    expect(
      conflictOf(
        input({ rateCards: [rate({ creditInputMiss: 0, creditInputHit: 0, creditOutput: 0 })] }),
      ).message,
    ).toContain('cannot be represented');
  });
});
