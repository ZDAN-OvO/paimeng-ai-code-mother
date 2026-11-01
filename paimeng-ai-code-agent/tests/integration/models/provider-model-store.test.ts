import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { modelAliases, modelConfigState, modelProviders, providerModels } from '@/server/infra/schema';
import { modelConfigStateId, type ModelProviderWriteInput } from '@/shared/model-config';
import {
  createProviderModel,
  deleteProvider,
  initializeModelConfigFromEnv,
  readConfigSnapshot,
  readProviderModels,
  updateProviderModel,
  upsertProvider,
} from '@/server/models/store';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const saved = new Map(['AI_MODEL', 'AI_BASE_URL', 'MODEL_API_KEY_ENV_ALLOWLIST', 'MODEL_INTERNAL_BASE_URL_ORIGINS'].map(name => [name, process.env[name]]));
const capabilities = { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false };

function provider(id: string, displayName = id): ModelProviderWriteInput {
  return {
    id,
    displayName,
    apiFormat: 'openai-chat',
    baseUrl: `https://${id}.example.test/v1`,
    apiKeySource: 'env',
    apiKeyEnv: 'AI_API_KEY',
    options: {},
    enabled: true,
  };
}

function model(providerId: string, upstreamModelName = 'same-model') {
  return {
    providerId,
    upstreamModelName,
    displayName: `${providerId} 的同名模型`,
    capabilities,
    compatibility: { reasoningContentPassthrough: false },
    enabled: true,
  };
}

async function resetDatabase() {
  await db().delete(modelAliases);
  await db().delete(providerModels);
  await db().delete(modelProviders);
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onConflictDoUpdate({ target: modelConfigState.id, set: { revision: 0n, refreshEpoch: 0n } });
}

/** 必需槽位必须先有别名，否则任何提供商写入都会被完整性校验拒绝。 */
async function seedRequiredSlots() {
  const result = await initializeModelConfigFromEnv();
  expect(result).toMatchObject({ initialized: true, revision: '1' });
}

describe('提供商模型存储', () => {
  beforeEach(async () => {
    process.env.AI_MODEL = 'gpt-test-model';
    process.env.AI_BASE_URL = 'https://api.example.test/v1';
    delete process.env.MODEL_API_KEY_ENV_ALLOWLIST;
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('迁移只追加可空引用，保留旧费率行与部分唯一索引', async () => {
    const { rows: columns } = await getPool().query<{ table_name: string; is_nullable: string }>(
      "SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'provider_model_id' ORDER BY table_name",
    );
    expect(columns).toEqual([
      { table_name: 'credit_rate_card', is_nullable: 'YES' },
      { table_name: 'generation_step', is_nullable: 'YES' },
      { table_name: 'model_alias', is_nullable: 'YES' },
    ]);

    const { rows: indexes } = await getPool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uk_credit_rate_card_provider_model_version'",
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('WHERE (provider_model_id IS NOT NULL)');

    const { rows: legacyRates } = await getPool().query<{ model_name: string; provider_model_id: string | null }>(
      "SELECT model_name, provider_model_id FROM credit_rate_card WHERE provider_id = 'env-default' ORDER BY model_name",
    );
    expect(legacyRates).toEqual([
      { model_name: 'deepseek-flash', provider_model_id: null },
      { model_name: 'deepseek-v4-pro', provider_model_id: null },
    ]);
  });

  it('同名请求模型在不同提供商下是两条独立身份', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('provider-a'), { expectedRevision: '1' });
    await upsertProvider(provider('provider-b'), { expectedRevision: '2' });
    const a = await createProviderModel(model('provider-a'), { expectedRevision: '3' });
    const b = await createProviderModel(model('provider-b'), { expectedRevision: '4' });

    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ revision: '4', refreshEpoch: '0' });
    expect(b).toMatchObject({ revision: '5', refreshEpoch: '0' });
    const snapshot = await readConfigSnapshot();
    expect(snapshot.revision).toBe('5');
    expect(snapshot.providerModels).toHaveLength(2);
    expect(snapshot.providerModels.map(item => [item.id, item.providerId, item.upstreamModelName]).sort()).toEqual([
      [a.id, 'provider-a', 'same-model'],
      [b.id, 'provider-b', 'same-model'],
    ]);
    expect(await readProviderModels()).toHaveLength(2);
  });

  it('同一提供商下仅大小写不同的请求名是两条身份', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    const upper = await createProviderModel(model('primary', 'Same-Model'), { expectedRevision: '2' });
    const lower = await createProviderModel(model('primary', 'same-model'), { expectedRevision: '3' });
    expect(upper.id).not.toBe(lower.id);
    const snapshot = await readConfigSnapshot();
    expect(snapshot.providerModels.map(item => item.upstreamModelName).sort()).toEqual(['Same-Model', 'same-model']);
  });

  it('同一提供商重复请求名被拒绝，不改变版本或已有记录', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    await createProviderModel(model('primary'), { expectedRevision: '2' });
    await expect(createProviderModel(model('primary'), { expectedRevision: '3' })).rejects.toMatchObject({ status: 409, code: 40904 });
    const snapshot = await readConfigSnapshot();
    expect(snapshot.revision).toBe('3');
    expect(snapshot.providerModels).toHaveLength(1);
  });

  it('更新只改展示、能力与兼容声明，保留身份并遵守版本冲突', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    const created = await createProviderModel(model('primary'), { expectedRevision: '2' });
    const before = (await readConfigSnapshot()).providerModels.find(item => item.id === created.id);
    const update = {
      displayName: '新的展示名',
      capabilities: { ...capabilities, imageInput: true },
      compatibility: { reasoningContentPassthrough: true },
      enabled: false,
    };
    const updated = await updateProviderModel(created.id, update, { expectedRevision: '3', applyImmediately: true });
    expect(updated).toEqual({ id: created.id, revision: '4', refreshEpoch: '1' });

    const stored = (await readConfigSnapshot()).providerModels.find(item => item.id === created.id);
    expect(stored).toMatchObject({
      id: created.id,
      providerId: 'primary',
      upstreamModelName: 'same-model',
      ...update,
    });
    expect(stored?.createTime).toBe(before?.createTime);
    expect(stored && before && stored.updateTime >= before.updateTime).toBe(true);

    await expect(updateProviderModel(created.id, update, { expectedRevision: '3' })).rejects.toMatchObject({ status: 409, code: 40901 });
    await expect(updateProviderModel('999', update, { expectedRevision: '4' })).rejects.toMatchObject({ status: 404, code: 40400 });
  });

  it('并发写入同一请求名返回 409，且不递增配置版本', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    const client = new pg.Client({ connectionString: testDatabaseUrl(process.env.DATABASE_URL ?? '') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO provider_model (id, provider_id, upstream_model_name, display_name, capabilities, compatibility, enabled, create_time, update_time)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1, timezone('UTC', now()), timezone('UTC', now()))`,
        ['9001', 'primary', 'same-model', '并发写入', JSON.stringify(capabilities), JSON.stringify({})],
      );
      const pending = createProviderModel(model('primary'), { expectedRevision: '2' });
      await new Promise(resolve => setTimeout(resolve, 250));
      await client.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ status: 409, code: 40904 });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
    const snapshot = await readConfigSnapshot();
    expect(snapshot.revision).toBe('2');
    expect(snapshot.providerModels).toHaveLength(1);
  });

  it('未知提供商不能登记，停用的提供商也保留其已登记身份', async () => {
    await seedRequiredSlots();
    await expect(createProviderModel(model('missing'), { expectedRevision: '1' })).rejects.toMatchObject({ status: 404, code: 40400 });
    expect((await readConfigSnapshot()).revision).toBe('1');

    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    await createProviderModel(model('primary'), { expectedRevision: '2' });
    await upsertProvider({ ...provider('primary'), enabled: false }, { expectedRevision: '3' });
    const snapshot = await readConfigSnapshot();
    expect(snapshot.providerModels).toHaveLength(1);
    expect(snapshot.revision).toBe('4');
  });

  it('提供商被已登记模型引用时不能删除', async () => {
    await seedRequiredSlots();
    await upsertProvider(provider('primary'), { expectedRevision: '1' });
    await createProviderModel(model('primary'), { expectedRevision: '2' });
    await expect(deleteProvider('primary', { expectedRevision: '3' })).rejects.toMatchObject({ status: 409, code: 40902 });
    expect((await readConfigSnapshot()).providers).toHaveLength(2);
  });
});
