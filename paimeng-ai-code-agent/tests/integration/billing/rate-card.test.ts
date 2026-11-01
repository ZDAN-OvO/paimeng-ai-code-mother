import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import {
  applyBillingMigrations,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  type BillingTestUser,
} from '../../support/billing';
import { db, getPool, now } from '@/server/infra/db';
import { creditRateCard, modelProviders, providerModels, sessions, users } from '@/server/infra/schema';
import { readRates, resolveRate, resolveRateById } from '@/server/billing/rate-card';
import type { RateCardList, RateCardView } from '@/shared/billing';

/** 本文件造的费率一律用这个前缀，收尾只删自己造的行，不碰迁移里的初始费率。 */
const providerPrefix = 'billing_test_';

let admin: BillingTestUser;
let owner: BillingTestUser;

function rateBody(overrides: Record<string, unknown> = {}) {
  return {
    providerId: `${providerPrefix}env`,
    modelName: 'demo-model',
    effectiveFrom: '2026-01-01 00:00:00.000',
    creditInputMiss: 100,
    creditInputHit: 10,
    creditOutput: 400,
    ...overrides,
  };
}

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('008_credit_rate_card.sql');
  admin = await createBillingUser({ role: 'admin' });
  owner = await createBillingUser();
});

async function seedProviderModel(providerId: string, modelId: string, upstreamModelName: string) {
  await db().insert(modelProviders).values({
    id: providerId,
    displayName: providerId,
    apiFormat: 'openai-chat',
    baseUrl: `https://${providerId}.example.test/v1`,
    apiKeyEnv: 'AI_API_KEY',
    options: {},
    enabled: 1,
    createTime: now(),
    updateTime: now(),
  });
  await db().insert(providerModels).values({
    id: BigInt(modelId),
    providerId,
    upstreamModelName,
    displayName: `${providerId} / ${upstreamModelName}`,
    capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false },
    compatibility: { reasoningContentPassthrough: false },
    enabled: 1,
    createTime: now(),
    updateTime: now(),
  });
}

afterAll(async () => {
  await db().delete(creditRateCard).where(like(creditRateCard.providerId, `${providerPrefix}%`));
  await db().delete(providerModels).where(like(providerModels.providerId, `${providerPrefix}%`));
  await db().delete(modelProviders).where(like(modelProviders.id, `${providerPrefix}%`));
  const ids = [admin?.id, owner?.id].filter((id): id is string => Boolean(id)).map((id) => BigInt(id));
  if (ids.length > 0) {
    await db().delete(sessions).where(inArray(sessions.userId, ids));
    await db().delete(users).where(inArray(users.id, ids));
  }
  await getPool().end();
});

describe('Rate card 数据库', () => {
  it('迁移带出经确认的初始费率，成本未知留空而不是编造', async () => {
    const rates = await readRates();
    const flash = rates.find((rate) => rate.providerId === 'env-default' && rate.modelName === 'deepseek-flash');
    expect(flash).toMatchObject({
      creditInputMiss: 600,
      creditInputHit: 12,
      creditOutput: 2500,
      costBasis: 'peak',
      usdInputMiss: '0.300000',
      usdInputHit: '0.006000',
      usdOutput: '1.200000',
    });
    expect(flash?.costSource).toContain('deepseek');

    const pro = rates.find((rate) => rate.providerId === 'env-default' && rate.modelName === 'deepseek-v4-pro');
    expect(pro).toMatchObject({
      creditInputMiss: 2600,
      creditInputHit: 50,
      creditOutput: 8500,
      costBasis: 'unknown',
      usdInputMiss: null,
      usdInputHit: null,
      usdOutput: null,
      costSource: null,
    });
  });

  it('追加新版本不覆盖历史行，按时刻各自解析到当时的价', async () => {
    const older = rateBody();
    const first = await envelopeOf<RateCardList['rates'][number]>(
      await billingRequest('admin/billing/rate-card', older, admin.cookie),
    );
    expect(first.code).toBe(0);
    const firstCreated = first.data;

    const newer = rateBody({ effectiveFrom: '2026-06-01 00:00:00.000', creditInputMiss: 200, creditInputHit: 20, creditOutput: 800 });
    const second = await envelopeOf(await billingRequest('admin/billing/rate-card', newer, admin.cookie));
    expect(second.code).toBe(0);

    const rates = (await readRates()).filter((rate) => rate.providerId === older.providerId);
    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({ effectiveFrom: '2026-06-01 00:00:00.000', creditInputMiss: 200 });
    expect(rates[1]).toEqual(firstCreated);

    expect(resolveRate(rates, older.providerId, older.modelName, '2026-03-01 00:00:00.000')?.creditInputMiss).toBe(100);
    expect(resolveRate(rates, older.providerId, older.modelName, '2026-07-01 00:00:00.000')?.creditInputMiss).toBe(200);
    expect(resolveRate(rates, older.providerId, older.modelName, '2025-12-31 23:59:59.999')).toBeNull();
  });

  it('相同模型与相同生效时间不能有两个版本', async () => {
    const body = rateBody({ providerId: `${providerPrefix}dup`, modelName: 'dup-model' });
    expect((await envelopeOf(await billingRequest('admin/billing/rate-card', body, admin.cookie))).code).toBe(0);
    const duplicate = await billingRequest('admin/billing/rate-card', body, admin.cookie);
    expect(duplicate.status).toBe(409);
    expect((await envelopeOf(duplicate)).code).toBe(40900);
  });

  it('非法费率被拒且不落库', async () => {
    const negative = await billingRequest(
      'admin/billing/rate-card',
      rateBody({ providerId: `${providerPrefix}bad`, creditOutput: -1 }),
      admin.cookie,
    );
    expect(negative.status).toBe(400);
    const allZero = await billingRequest(
      'admin/billing/rate-card',
      rateBody({ providerId: `${providerPrefix}bad`, creditInputMiss: 0, creditInputHit: 0, creditOutput: 0 }),
      admin.cookie,
    );
    expect(allZero.status).toBe(400);
    expect((await readRates()).filter((rate) => rate.providerId === `${providerPrefix}bad`)).toHaveLength(0);
  });

  it('按模型 ID 追加费率：身份从模型派生，历史与当前版本按 ID 解析', async () => {
    const providerId = `${providerPrefix}model_provider`;
    const modelId = '910000000000000001';
    await seedProviderModel(providerId, modelId, 'model-identity');

    const first = await envelopeOf<RateCardView>(await billingRequest('admin/billing/rate-card', {
      providerModelId: modelId,
      effectiveFrom: '2026-01-01 00:00:00.000',
      creditInputMiss: 111,
      creditInputHit: 11,
      creditOutput: 1111,
    }, admin.cookie));
    expect(first.code).toBe(0);
    expect(first.data).toMatchObject({
      providerModelId: modelId,
      providerId,
      modelName: 'model-identity',
      creditInputMiss: 111,
    });

    const second = await envelopeOf<RateCardView>(await billingRequest('admin/billing/rate-card', {
      providerModelId: modelId,
      effectiveFrom: '2026-06-01 00:00:00.000',
      creditInputMiss: 222,
      creditInputHit: 22,
      creditOutput: 2222,
    }, admin.cookie));
    expect(second.code).toBe(0);

    const rates = (await readRates()).filter(rate => rate.providerModelId === modelId);
    expect(rates).toHaveLength(2);
    expect(resolveRateById(rates, modelId, '2026-03-01 00:00:00.000')?.creditInputMiss).toBe(111);
    expect(resolveRateById(rates, modelId, '2026-07-01 00:00:00.000')?.creditInputMiss).toBe(222);
    expect(resolveRateById(rates, '910000000000000099', '2026-07-01 00:00:00.000')).toBeNull();

    // 同名旧费率不参与新 ID 的解析。
    await envelopeOf(await billingRequest('admin/billing/rate-card', rateBody({
      providerId,
      modelName: 'model-identity',
      effectiveFrom: '2026-02-01 00:00:00.000',
      creditInputMiss: 333,
    }), admin.cookie));
    const mixed = (await readRates()).filter(rate => rate.providerId === providerId);
    expect(resolveRateById(mixed, modelId, '2026-03-01 00:00:00.000')?.creditInputMiss).toBe(111);

    const list = await envelopeOf<RateCardList>(await billingRequest('admin/billing/rate-card', undefined, admin.cookie));
    expect(list.data.effectiveNow).toContainEqual(expect.objectContaining({ providerModelId: modelId, effectiveFrom: '2026-06-01 00:00:00.000' }));
  });

  it('按模型 ID 的重复版本与未知模型被明确拒绝', async () => {
    const providerId = `${providerPrefix}model_dup`;
    const modelId = '910000000000000002';
    await seedProviderModel(providerId, modelId, 'model-dup');
    const body = {
      providerModelId: modelId,
      effectiveFrom: '2026-01-01 00:00:00.000',
      creditInputMiss: 1,
      creditInputHit: 1,
      creditOutput: 1,
    };
    expect((await envelopeOf(await billingRequest('admin/billing/rate-card', body, admin.cookie))).code).toBe(0);
    const duplicate = await billingRequest('admin/billing/rate-card', body, admin.cookie);
    expect(duplicate.status).toBe(409);
    expect((await envelopeOf(duplicate)).code).toBe(40900);

    const unknown = await billingRequest('admin/billing/rate-card', { ...body, providerModelId: '910000000000000099' }, admin.cookie);
    expect(unknown.status).toBe(404);
    expect((await envelopeOf(unknown)).code).toBe(40400);

    const both = await billingRequest('admin/billing/rate-card', {
      ...body,
      providerId: providerId,
      modelName: 'model-dup',
    }, admin.cookie);
    expect(both.status).toBe(400);
  });

  it('已登记模型只允许用旧写法补历史价，当前或未来价必须带模型 ID', async () => {
    const providerId = `${providerPrefix}legacy_guard`;
    const modelId = '910000000000000003';
    await seedProviderModel(providerId, modelId, 'legacy-guard-model');

    const future = await billingRequest('admin/billing/rate-card', rateBody({
      providerId,
      modelName: 'legacy-guard-model',
      effectiveFrom: '2099-01-01 00:00:00.000',
    }), admin.cookie);
    expect(future.status).toBe(409);
    expect((await envelopeOf(future)).code).toBe(40900);

    const past = await envelopeOf<RateCardView>(await billingRequest('admin/billing/rate-card', rateBody({
      providerId,
      modelName: 'legacy-guard-model',
      effectiveFrom: '2020-01-01 00:00:00.000',
    }), admin.cookie));
    expect(past.code).toBe(0);
    expect(past.data).toMatchObject({ providerId, modelName: 'legacy-guard-model', providerModelId: null });
  });

  it('未命中的模型身份明确是未定价，不回退常量', async () => {
    const rates = await readRates();
    for (const providerId of ['durable', 'fixture']) {
      expect(resolveRate(rates, providerId, 'deepseek-flash', '2026-10-15 00:00:00.000')).toBeNull();
    }
    expect(resolveRate(rates, null, null, '2026-10-15 00:00:00.000')).toBeNull();
  });
});

describe('Rate card 管理接口权限', () => {
  it('未登录与普通用户都不能读费率表', async () => {
    expect((await billingRequest('admin/billing/rate-card')).status).toBe(401);
    expect((await billingRequest('admin/billing/rate-card', undefined, owner.cookie)).status).toBe(403);
  });

  it('普通用户不能追加费率版本', async () => {
    const response = await billingRequest(
      'admin/billing/rate-card',
      rateBody({ providerId: `${providerPrefix}owner`, modelName: 'owner-model' }),
      owner.cookie,
    );
    expect(response.status).toBe(403);
    expect((await readRates()).filter((rate) => rate.providerId === `${providerPrefix}owner`)).toHaveLength(0);
  });

  it('Admin 读到费率表、三列顺序与单位文案', async () => {
    const response = await billingRequest('admin/billing/rate-card', undefined, admin.cookie);
    expect(response.status).toBe(200);
    const payload = (await envelopeOf<RateCardList>(response)).data;
    expect(payload.columns.map((column) => column.key)).toEqual(['creditInputMiss', 'creditInputHit', 'creditOutput']);
    expect(payload.unit).toEqual({
      creditPerYuan: 100,
      tokensPerMillion: 1_000_000,
      rateLabel: 'Credit / 1M tokens',
      denominationLabel: '1 Credit = ¥0.01',
    });
    expect(payload.rates).toContainEqual(
      expect.objectContaining({ providerId: 'env-default', modelName: 'deepseek-flash', creditInputMiss: 600 }),
    );
    expect(payload.effectiveNow).toContainEqual({
      providerId: 'env-default',
      modelName: 'deepseek-flash',
      providerModelId: null,
      effectiveFrom: '2026-10-01 00:00:00.000',
    });
  });

  it('Admin 追加的版本带上创建人，并立即出现在费率表里', async () => {
    const body = rateBody({ providerId: `${providerPrefix}admin`, modelName: 'admin-model', costSource: 'https://example.test/pricing' });
    const created = await envelopeOf<RateCardList['rates'][number]>(
      await billingRequest('admin/billing/rate-card', body, admin.cookie),
    );
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({
      providerId: `${providerPrefix}admin`,
      modelName: 'admin-model',
      effectiveFrom: '2026-01-01 00:00:00.000',
      creditInputMiss: 100,
      createdBy: admin.id,
      costSource: 'https://example.test/pricing',
      costBasis: null,
    });
    const listed = await envelopeOf<RateCardList>(await billingRequest('admin/billing/rate-card', undefined, admin.cookie));
    expect(listed.data.rates).toContainEqual(expect.objectContaining({ providerId: `${providerPrefix}admin`, createdBy: admin.id }));
  });
});
