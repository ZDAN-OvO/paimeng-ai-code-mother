import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../../support/test-database-url';
import { getPool } from '@/server/infra/db';
import { getConfig } from '@/server/infra/config';
import type {
  ModelAliasCapabilities,
  ModelProviderOptions,
  ModelProviderWriteInput,
  ProviderApiFormat,
  ProviderKeySource,
} from '@/shared/model-config';
import type { ModelConfigMutation } from '@/shared/model-document';
import {
  patchTestDocument,
  resetModelConfigRow,
  writeTestDocument,
} from '../../support/model-config';
import { decryptModelSecret } from '@/server/models/secrets';
import {
  applyModelConfig,
  initializeModelConfigFromEnv,
  mutateModelConfig,
  readConfigSnapshot,
  readModelConfigDocumentState,
  readRefreshEpoch,
  upsertProvider,
} from '@/server/models/store';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const saved = new Map(
  [
    'AI_MODEL',
    'AI_BASE_URL',
    'MODEL_API_KEY_ENV_ALLOWLIST',
    'MODEL_INTERNAL_BASE_URL_ORIGINS',
    'MODEL_SECRET_KEY',
  ].map((name) => [name, process.env[name]]),
);

type ProviderDraft = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKey: string;
  options: ModelProviderOptions;
  enabled: boolean;
};

const providerDraft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: 'primary',
  displayName: '主提供商',
  apiFormat: 'openai-chat',
  baseUrl: 'https://api.example.test/v1',
  apiKeySource: 'env',
  apiKeyEnv: 'AI_API_KEY',
  apiKey: 'sk-test',
  options: {},
  enabled: true,
  ...overrides,
});

const provider = (overrides: Partial<ProviderDraft> = {}): ModelProviderWriteInput => {
  const draft = providerDraft(overrides);
  const common = {
    id: draft.id,
    displayName: draft.displayName,
    apiFormat: draft.apiFormat,
    baseUrl: draft.baseUrl,
    options: draft.options,
    enabled: draft.enabled,
  };
  return draft.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: draft.apiKey };
};

const allCapabilities: ModelAliasCapabilities = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  imageInput: false,
};

async function state() {
  return readModelConfigDocumentState();
}

async function mutate(revision: string, mutation: ModelConfigMutation) {
  return mutateModelConfig({ expectedRevision: revision, mutation });
}

async function createModel(
  providerId: string,
  upstream: string,
  capabilities: ModelAliasCapabilities = allCapabilities,
  revision?: string,
) {
  const current = revision ?? (await state()).revision;
  return mutate(current, {
    kind: 'model.upsert',
    providerId,
    upstream,
    displayName: upstream,
    capabilities,
    enabled: true,
    upstreamPrice: null,
  });
}

async function priceModel(modelId: string, revision: string) {
  return mutate(revision, {
    kind: 'model.price',
    modelId,
    inputMissFen: 100,
    inputHitFen: 10,
    outputFen: 400,
    upstreamUsd: null,
    note: null,
  });
}

describe('模型配置 JSON 存储', () => {
  beforeEach(async () => {
    process.env.AI_MODEL = 'gpt-test-model';
    process.env.AI_BASE_URL = 'https://api.example.test/v1';
    process.env.MODEL_SECRET_KEY = 'a'.repeat(64);
    delete process.env.MODEL_API_KEY_ENV_ALLOWLIST;
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    await resetModelConfigRow();
  });

  afterAll(async () => {
    await resetModelConfigRow();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('空文档可读取，版本为零', async () => {
    const snapshot = await readConfigSnapshot();
    expect(snapshot).toMatchObject({
      revision: '0',
      refreshEpoch: '0',
      providers: [],
      aliases: [],
    });
    expect(await readRefreshEpoch()).toBe('0');
    const { document } = await state();
    expect(document).toMatchObject({
      schemaVersion: 1,
      providers: [],
      slots: [],
      legacyPrices: [],
    });
  });

  it('仅当配置为空时从环境变量初始化提供商、一个未定价模型与两个必需槽位', async () => {
    const first = await initializeModelConfigFromEnv();
    expect(first).toEqual({
      initialized: true,
      revision: '1',
      refreshEpoch: '0',
      providerId: 'env-default',
    });

    const { document } = await state();
    expect(document.providers).toHaveLength(1);
    expect(document.providers[0]).toMatchObject({
      id: 'env-default',
      baseUrl: 'https://api.example.test/v1',
      apiKey: { source: 'env', env: 'AI_API_KEY' },
      enabled: true,
    });
    expect(document.providers[0]?.models).toHaveLength(1);
    const model = document.providers[0].models[0];
    expect(model.upstream).toBe('gpt-test-model');
    expect(model.prices).toEqual([]);
    expect(document.slots.map((slot) => slot.slot).sort()).toEqual([
      'codegen.default',
      'route.classify',
    ]);
    expect(new Set(document.slots.map((slot) => slot.modelId))).toEqual(new Set([model.id]));

    const snapshot = await readConfigSnapshot();
    expect(snapshot.aliases.map((alias) => alias.alias).sort()).toEqual([
      'codegen.default',
      'route.classify',
    ]);
    expect(snapshot.aliases.every((alias) => alias.modelName === 'gpt-test-model')).toBe(true);

    const second = await initializeModelConfigFromEnv();
    expect(second).toEqual({
      initialized: false,
      revision: '1',
      refreshEpoch: '0',
      providerId: null,
    });
  });

  it('提供商写入递增版本并保留模型；过期版本返回 409', async () => {
    await initializeModelConfigFromEnv();
    const before = await state();
    const updated = await upsertProvider(provider({ id: 'env-default', displayName: '改名后' }), {
      expectedRevision: '1',
    });
    expect(updated).toMatchObject({ revision: '2', refreshEpoch: '0' });

    const after = await state();
    expect(after.document.providers[0]?.displayName).toBe('改名后');
    expect(after.document.providers[0]?.createTime).toBe(before.document.providers[0]?.createTime);
    expect(after.document.providers[0]?.models).toEqual(before.document.providers[0]?.models);

    await expect(
      upsertProvider(provider({ id: 'env-default' }), { expectedRevision: '1' }),
    ).rejects.toMatchObject({ status: 409, code: 40901 });
  });

  it('applyImmediately 递增刷新序号，手动应用只递增刷新序号', async () => {
    await initializeModelConfigFromEnv();
    const plain = await upsertProvider(provider({ id: 'env-default', displayName: '普通保存' }), {
      expectedRevision: '1',
    });
    expect(plain).toMatchObject({ revision: '2', refreshEpoch: '0' });

    const immediate = await upsertProvider(
      provider({ id: 'env-default', displayName: '立即生效' }),
      { expectedRevision: '2', applyImmediately: true },
    );
    expect(immediate).toMatchObject({ revision: '3', refreshEpoch: '1' });

    const applied = await applyModelConfig({ expectedRevision: '3' });
    expect(applied).toMatchObject({ revision: '3', refreshEpoch: '2' });
    expect(await readRefreshEpoch()).toBe('2');

    await expect(applyModelConfig({ expectedRevision: '2' })).rejects.toMatchObject({
      status: 409,
      code: 40901,
    });
  });

  it('并发写入同一期望版本时只有一个成功', async () => {
    await initializeModelConfigFromEnv();
    const outcomes = await Promise.allSettled([
      upsertProvider(provider({ id: 'env-default', displayName: '并发甲' }), {
        expectedRevision: '1',
      }),
      upsertProvider(provider({ id: 'env-default', displayName: '并发乙' }), {
        expectedRevision: '1',
      }),
    ]);
    const fulfilled = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.revision).toBe('2');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: 409, code: 40901 });
    expect((await state()).revision).toBe('2');
  });

  it('被槽位引用的模型不能停用；有模型的提供商不能删除；必需槽位不能清除', async () => {
    await initializeModelConfigFromEnv();
    const current = await state();
    const modelId = current.document.providers[0].models[0].id;
    await expect(
      mutate(current.revision, { kind: 'model.enabled', modelId, enabled: false }),
    ).rejects.toMatchObject({
      status: 409,
      code: 40902,
      message: expect.stringContaining('codegen.default'),
    });
    await expect(
      mutate(current.revision, { kind: 'provider.delete', providerId: 'env-default' }),
    ).rejects.toMatchObject({ status: 409, code: 40902 });
    await expect(
      mutate(current.revision, { kind: 'slot.clear', slot: 'codegen.default' }),
    ).rejects.toMatchObject({ status: 409, code: 40902 });
    await expect(
      mutate(current.revision, { kind: 'provider.delete', providerId: 'missing' }),
    ).rejects.toMatchObject({ status: 404, code: 40400 });
    expect(await state().then((value) => value.revision)).toBe('1');
  });

  it('未定价模型不能分配；追加单价后可以分配，并可共享给多个槽位', async () => {
    await initializeModelConfigFromEnv();
    const current = await state();
    const modelId = current.document.providers[0].models[0].id;
    await expect(
      mutate(current.revision, {
        kind: 'slot.assign',
        slot: 'codegen.default',
        modelId,
        settings: {},
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 40000,
      message: expect.stringContaining('还没有当前生效的单价'),
    });

    const priced = await priceModel(modelId, current.revision);
    await expect(
      mutate(priced.revision, {
        kind: 'slot.assign',
        slot: 'codegen.default',
        modelId,
        settings: { temperature: 0.2 },
      }),
    ).resolves.toMatchObject({ revision: '3' });
    const assigned = await mutate('3', {
      kind: 'slot.assign',
      slot: 'version.summary',
      modelId,
      settings: { maxOutputTokens: 200 },
    });
    const next = await state();
    expect(assigned.revision).toBe('4');
    expect(next.document.providers[0]?.models[0]?.prices).toHaveLength(1);
    expect(next.document.slots.find((slot) => slot.slot === 'codegen.default')?.settings).toEqual({
      temperature: 0.2,
    });
    expect(next.document.slots.find((slot) => slot.slot === 'version.summary')?.settings).toEqual({
      maxOutputTokens: 200,
    });

    await expect(
      mutate('4', { kind: 'slot.clear', slot: 'version.summary' }),
    ).resolves.toMatchObject({ revision: '5' });
    expect((await state()).document.slots.some((slot) => slot.slot === 'version.summary')).toBe(
      false,
    );
  });

  it('槽位能力不足时点名能力；未知槽位与不存在的模型被拒绝', async () => {
    await initializeModelConfigFromEnv();
    const created = await createModel('env-default', 'no-tools-model', {
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
      imageInput: false,
    });
    const next = await state();
    const modelId = next.document.providers[0].models.find(
      (model) => model.upstream === 'no-tools-model',
    )!.id;
    const priced = await priceModel(modelId, created.revision);
    await expect(
      mutate(priced.revision, {
        kind: 'slot.assign',
        slot: 'codegen.default',
        modelId,
        settings: {},
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 40000,
      message: expect.stringContaining('工具调用'),
    });
    await expect(
      mutate(priced.revision, { kind: 'slot.assign', slot: 'extra.model', modelId, settings: {} }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      mutate(priced.revision, {
        kind: 'slot.assign',
        slot: 'route.classify',
        modelId: 'pm_missing',
        settings: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: 40400 });
  });

  it('价格版本只追加，版本号递增且当前价取最近生效版本', async () => {
    await initializeModelConfigFromEnv();
    const current = await state();
    const modelId = current.document.providers[0].models[0].id;
    const first = await priceModel(modelId, current.revision);
    const second = await mutate(first.revision, {
      kind: 'model.price',
      modelId,
      inputMissFen: 200,
      inputHitFen: 20,
      outputFen: 800,
      upstreamUsd: { inputMiss: '0.5', inputHit: '0.1', output: '2.0' },
      note: '涨价',
    });
    expect(second.revision).toBe('3');
    const prices = (await state()).document.providers[0].models[0].prices;
    expect(prices.map((price) => price.version)).toEqual([1, 2]);
    expect(prices[0]).toMatchObject({ inputMissFen: 100, inputHitFen: 10, outputFen: 400 });
    expect(prices[1]).toMatchObject({
      inputMissFen: 200,
      upstreamUsd: { inputMiss: '0.5' },
      note: '涨价',
    });
  });

  it('直接输入的密钥只以密文入库，留空保持原值，切回环境变量时清除密文', async () => {
    await initializeModelConfigFromEnv();
    await expect(
      upsertProvider(
        provider({ id: 'env-default', apiKeySource: 'inline', apiKey: 'sk-secret-value' }),
        { expectedRevision: '1' },
      ),
    ).resolves.toMatchObject({ revision: '2' });
    const inline = (await state()).document.providers[0];
    expect(inline.apiKey).toMatchObject({ source: 'inline' });
    expect(JSON.stringify(inline)).not.toContain('sk-secret-value');
    expect(
      inline.apiKey.source === 'inline' ? decryptModelSecret(inline.apiKey.ciphertext) : null,
    ).toBe('sk-secret-value');

    await expect(
      upsertProvider(provider({ id: 'env-default', apiKeySource: 'inline', apiKey: '' }), {
        expectedRevision: '2',
      }),
    ).resolves.toMatchObject({ revision: '3' });
    const kept = (await state()).document.providers[0];
    expect(
      kept.apiKey.source === 'inline' ? decryptModelSecret(kept.apiKey.ciphertext) : null,
    ).toBe('sk-secret-value');

    await expect(
      upsertProvider(
        provider({ id: 'env-default', apiKeySource: 'env', apiKeyEnv: 'AI_API_KEY' }),
        { expectedRevision: '3' },
      ),
    ).resolves.toMatchObject({ revision: '4' });
    expect((await state()).document.providers[0]?.apiKey).toEqual({
      source: 'env',
      env: 'AI_API_KEY',
    });
  });

  it('自定义请求头随配置保存、读取、编辑与清除', async () => {
    await initializeModelConfigFromEnv();
    const withHeaders: ModelProviderWriteInput = {
      ...provider({ id: 'env-default' }),
      headers: { 'User-Agent': 'paimeng-ai-code-mother/1.0', 'X-Title': 'paimeng' },
    };
    await expect(upsertProvider(withHeaders, { expectedRevision: '1' })).resolves.toMatchObject({
      revision: '2',
    });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({
      'User-Agent': 'paimeng-ai-code-mother/1.0',
      'X-Title': 'paimeng',
    });

    await expect(
      upsertProvider(
        { ...provider({ id: 'env-default' }), headers: { 'X-Title': 'edited' } },
        { expectedRevision: '2' },
      ),
    ).resolves.toMatchObject({ revision: '3' });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({ 'X-Title': 'edited' });

    await expect(
      upsertProvider(provider({ id: 'env-default' }), { expectedRevision: '3' }),
    ).resolves.toMatchObject({ revision: '4' });
    expect((await readConfigSnapshot()).providers[0]?.headers).toEqual({});
  });

  it('新建直接密钥为空时被拒绝；未允许的环境变量被拒绝', async () => {
    await initializeModelConfigFromEnv();
    await expect(
      upsertProvider(provider({ id: 'secondary', apiKeySource: 'inline', apiKey: '' }), {
        expectedRevision: '1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      upsertProvider(provider({ id: 'secondary', apiKeyEnv: 'SECONDARY_KEY' }), {
        expectedRevision: '1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    process.env.MODEL_API_KEY_ENV_ALLOWLIST = 'SECONDARY_KEY';
    await expect(
      upsertProvider(provider({ id: 'secondary', apiKeyEnv: 'SECONDARY_KEY' }), {
        expectedRevision: '1',
      }),
    ).resolves.toMatchObject({ revision: '2' });
  });

  it('切换 API 格式后旧选项不再被接受', async () => {
    await initializeModelConfigFromEnv();
    await expect(
      upsertProvider(
        provider({ id: 'env-default', apiFormat: 'openai-chat', options: { includeUsage: true } }),
        { expectedRevision: '1' },
      ),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      upsertProvider(
        provider({
          id: 'env-default',
          apiFormat: 'openai-responses',
          options: { includeUsage: true },
        }),
        { expectedRevision: '2' },
      ),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      upsertProvider(provider({ id: 'env-default', apiFormat: 'openai-responses', options: {} }), {
        expectedRevision: '2',
      }),
    ).resolves.toMatchObject({ revision: '3' });
  });

  it('配置为空但版本非零时拒绝重新初始化', async () => {
    await initializeModelConfigFromEnv();
    await writeTestDocument(
      { schemaVersion: 1, providers: [], slots: [], legacyPrices: [] },
      { bumpRevision: false },
    );
    await expect(initializeModelConfigFromEnv()).rejects.toMatchObject({
      status: 409,
      code: 40903,
    });
    await writeTestDocument(
      { schemaVersion: 1, providers: [], slots: [], legacyPrices: [] },
      { bumpRevision: false, refreshEpoch: 4n },
    );
    await expect(initializeModelConfigFromEnv()).rejects.toMatchObject({
      status: 409,
      code: 40903,
    });
    await resetModelConfigRow();
    await expect(initializeModelConfigFromEnv()).resolves.toMatchObject({
      initialized: true,
      revision: '1',
      refreshEpoch: '0',
      providerId: 'env-default',
    });
  });

  it('并发编辑期间一致性读不会看到不完整配置', async () => {
    await initializeModelConfigFromEnv();
    const writer = (async () => {
      let version = await upsertProvider(provider({ id: 'env-default', displayName: '轮换 0' }), {
        expectedRevision: '1',
        applyImmediately: true,
      });
      for (let index = 1; index <= 5; index += 1) {
        version = await upsertProvider(
          provider({ id: 'env-default', displayName: `轮换 ${index}` }),
          { expectedRevision: version.revision, applyImmediately: true },
        );
      }
      return version;
    })();
    const expectedPairing: Record<string, { revision: string; refreshEpoch: string }> = {
      环境默认提供商: { revision: '1', refreshEpoch: '0' },
    };
    for (let index = 0; index <= 5; index += 1)
      expectedPairing[`轮换 ${index}`] = {
        revision: String(index + 2),
        refreshEpoch: String(index + 1),
      };
    const reads = Array.from({ length: 10 }, async () => {
      const snapshot = await readConfigSnapshot();
      expect(snapshot.providers).toHaveLength(1);
      const [modelProvider] = snapshot.providers;
      const pairing = modelProvider ? expectedPairing[modelProvider.displayName] : undefined;
      if (!modelProvider || !pairing)
        throw new Error(`未预期的提供商状态 ${modelProvider?.displayName ?? '缺失'}`);
      expect(snapshot.revision).toBe(pairing.revision);
      expect(snapshot.refreshEpoch).toBe(pairing.refreshEpoch);
      expect(snapshot.aliases.map((alias) => alias.alias).sort()).toEqual([
        'codegen.default',
        'route.classify',
      ]);
      const providerIds = new Set(snapshot.providers.map((candidate) => candidate.id));
      for (const alias of snapshot.aliases) expect(providerIds.has(alias.providerId)).toBe(true);
    });
    const final = await writer;
    await Promise.all(reads);
    expect(final).toMatchObject({ revision: '7', refreshEpoch: '6' });
  });

  it('HTTP 地址在本机/局域网或部署允许名单内放行', async () => {
    await initializeModelConfigFromEnv();
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://api.example.test/v1' }), {
        expectedRevision: '1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:8080/v1' }), {
        expectedRevision: '1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://127.0.0.1:8787/v1' }), {
        expectedRevision: '1',
      }),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://192.168.1.20:8080/v1' }), {
        expectedRevision: '2',
      }),
    ).resolves.toMatchObject({ revision: '3' });
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = 'http://internal.example:8080';
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:8080/v1' }), {
        expectedRevision: '3',
      }),
    ).resolves.toMatchObject({ revision: '4' });
    await expect(
      upsertProvider(provider({ id: 'env-default', baseUrl: 'http://internal.example:9090/v1' }), {
        expectedRevision: '4',
      }),
    ).rejects.toMatchObject({ status: 400, code: 40000 });
  });

  it('损坏的 JSON 或未知 schemaVersion 读取失败而不是回退', async () => {
    await patchTestDocument((document) => {
      (document as { schemaVersion: number }).schemaVersion = 99;
    });
    await expect(readConfigSnapshot()).rejects.toThrow();
    await resetModelConfigRow();
    expect((await readConfigSnapshot()).providers).toEqual([]);
  });

  it('部署允许名单条目非法时配置加载失败', () => {
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = 'ftp://gateway.example';
    expect(() => getConfig()).toThrow('MODEL_INTERNAL_BASE_URL_ORIGINS 第 1 项只允许 HTTP(S)');
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    process.env.MODEL_API_KEY_ENV_ALLOWLIST = 'not-a-name';
    expect(() => getConfig()).toThrow('MODEL_API_KEY_ENV_ALLOWLIST 第 1 项不是合法的环境变量名');
  });
});
