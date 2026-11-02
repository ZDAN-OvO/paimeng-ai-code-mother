import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBillingMigrations,
  billingRateProvider,
  billingRequest,
  createBillingUser,
  envelopeOf,
  loadBillingDatabase,
  purgeBillingRateCards,
  seedBillingRate,
  type BillingTestUser,
} from '../../support/billing';
import { getPool } from '@/server/infra/db';
import { readRates, resolveRate } from '@/server/billing/rate-card';

/**
 * 价格来源接缝：JSON 文档中的价格版本 + 迁移遗留的历史价。
 * Rate card 管理页面/接口已移除；这里验证旧入口不再存在，而结算读取仍按 (provider, model, effectiveAt) 解析。
 */

let admin: BillingTestUser;
let owner: BillingTestUser;

beforeAll(async () => {
  loadBillingDatabase();
  await applyBillingMigrations('008_credit_rate_card.sql', '023_app_config_model_config.sql');
  admin = await createBillingUser({ role: 'admin' });
  owner = await createBillingUser();
});

afterAll(async () => {
  await purgeBillingRateCards();
  await getPool().end();
});

describe('模型价格来自 JSON 文档', () => {
  it('价格版本按分存储，读取时 1 分 = 1 Credit', async () => {
    await seedBillingRate({ modelName: 'json-priced-model', creditInputMiss: 520, creditInputHit: 52, creditOutput: 1860 });
    const rates = await readRates();
    const rate = rates.find(candidate => candidate.providerId === billingRateProvider && candidate.modelName === 'json-priced-model');
    expect(rate).toMatchObject({ creditInputMiss: 520, creditInputHit: 52, creditOutput: 1860, effectiveFrom: '2020-01-01 00:00:00.000' });
  });

  it('同一模型名在不同提供商下价格独立', async () => {
    await seedBillingRate({ modelName: 'shared-name', providerId: 'provider-a', creditInputMiss: 100 });
    await seedBillingRate({ modelName: 'shared-name', providerId: 'provider-b', creditInputMiss: 900 });
    const rates = await readRates();
    expect(resolveRate(rates, 'provider-a', 'shared-name', '2026-01-01 00:00:00.000')?.creditInputMiss).toBe(100);
    expect(resolveRate(rates, 'provider-b', 'shared-name', '2026-01-01 00:00:00.000')?.creditInputMiss).toBe(900);
  });

  it('未来价格版本不会提前生效', async () => {
    await seedBillingRate({ modelName: 'future-model', creditInputMiss: 100 });
    await seedBillingRate({ modelName: 'future-model', creditInputMiss: 900, effectiveAt: '2099-01-01 00:00:00.000' });
    const rates = await readRates();
    expect(resolveRate(rates, billingRateProvider, 'future-model', '2026-01-01 00:00:00.000')?.creditInputMiss).toBe(100);
    expect(resolveRate(rates, billingRateProvider, 'future-model', '2099-06-01 00:00:00.000')?.creditInputMiss).toBe(900);
  });

  it('Rate card 管理接口已移除：管理员访问得到 404，不再有写入入口', async () => {
    const read = await billingRequest('admin/billing/rate-card', undefined, admin.cookie);
    expect(read.status).toBe(404);
    const write = await billingRequest('admin/billing/rate-card', {
      providerId: 'any-provider',
      modelName: 'any-model',
      effectiveFrom: '2026-01-01 00:00:00.000',
      creditInputMiss: 100,
      creditInputHit: 10,
      creditOutput: 400,
    }, admin.cookie);
    expect(write.status).toBe(404);
    expect((await envelopeOf(write)).code).toBe(40400);
    expect((await billingRequest('admin/billing/rate-card', undefined, owner.cookie)).status).toBe(403);
  });
});
