import { describe, expect, it } from 'vitest';
import { ratesFromDocument, rateViewOfPrice, resolveRate, SELL_UNIT } from '@/server/billing/rate-card';
import { creditDenominationLabel, rateCardUnitLabel, type RateCardView } from '@/shared/billing';
import type { ModelConfigDocument } from '@/shared/model-document';

/** 只填费率解析关心的字段，其余按「成本未知」构造。 */
function rate(providerId: string, modelName: string, effectiveFrom: string, creditInputMiss = 600): RateCardView {
  return {
    providerId,
    modelName,
    effectiveFrom,
    creditInputMiss,
    creditInputHit: 12,
    creditOutput: 2500,
    usdInputMiss: null,
    usdInputHit: null,
    usdOutput: null,
    costBasis: null,
    costSource: null,
    note: null,
    createdBy: null,
    createTime: effectiveFrom,
  };
}

const rates: RateCardView[] = [
  rate('env-default', 'deepseek-flash', '2026-10-01 00:00:00.000'),
  rate('env-default', 'deepseek-flash', '2026-11-01 00:00:00.000', 900),
  rate('env-default', 'deepseek-v4-pro', '2026-10-01 00:00:00.000', 2600),
  rate('durable', 'deepseek-flash', '2026-10-01 00:00:00.000', 700),
];

describe('按步骤时刻解析费率', () => {
  it('取步骤时刻之前最新的版本', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-15 08:00:00.000')?.creditInputMiss).toBe(600);
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-11-15 08:00:00.000')?.creditInputMiss).toBe(900);
  });

  it('未来版本不得提前生效', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-31 23:59:59.999')?.creditInputMiss).toBe(600);
  });

  it('生效时刻本身算生效，毫秒缺省不影响边界', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-11-01 00:00:00.000')?.creditInputMiss).toBe(900);
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-01 00:00:00')?.creditInputMiss).toBe(600);
  });

  it('早于最早版本时返回未定价', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-09-30 23:59:59.999')).toBeNull();
  });

  it('提供商与模型名一起参与匹配，不串号', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-v4-pro', '2026-10-15 00:00:00.000')?.creditInputMiss).toBe(2600);
    expect(resolveRate(rates, 'durable', 'deepseek-flash', '2026-10-15 00:00:00.000')?.creditInputMiss).toBe(700);
    expect(resolveRate(rates, 'env-default', 'gpt-4o', '2026-10-15 00:00:00.000')).toBeNull();
  });
});

describe('JSON 价格版本转费率视图', () => {
  it('分直接等于 Credit，元显示为分 / 100', () => {
    const view = rateViewOfPrice('env-default', 'deepseek-flash', {
      version: 1,
      effectiveAt: '2026-11-02 10:30:00.000',
      currency: 'CNY',
      inputMissFen: 520,
      inputHitFen: 52,
      outputFen: 1860,
      upstreamUsd: { inputMiss: '0.28', inputHit: '0.028', output: '1.10' },
      note: null,
    });
    expect(view).toMatchObject({
      providerId: 'env-default',
      modelName: 'deepseek-flash',
      effectiveFrom: '2026-11-02 10:30:00.000',
      creditInputMiss: 520,
      creditInputHit: 52,
      creditOutput: 1860,
      usdInputMiss: '0.28',
      usdInputHit: '0.028',
      usdOutput: '1.10',
      costBasis: 'unknown',
    });
  });

  it('同一提供商同名模型只保留自己的价格，孤儿历史价单独保留', () => {
    const document: ModelConfigDocument = {
      schemaVersion: 1,
      providers: [{
        id: 'env-default',
        displayName: '默认',
        apiFormat: 'openai-chat',
        baseUrl: 'https://api.example.test/v1',
        apiKey: { source: 'env', env: 'AI_API_KEY' },
        options: {},
        headers: {},
        enabled: true,
        createTime: '2026-01-01 00:00:00.000',
        updateTime: '2026-01-01 00:00:00.000',
        models: [{
          id: 'pm_1',
          upstream: 'deepseek-flash',
          displayName: 'Flash',
          enabled: true,
          capabilities: { streaming: true, toolCalling: true, structuredOutput: true, imageInput: false },
          upstreamPrice: null,
          prices: [{
            version: 1,
            effectiveAt: '2026-10-01 00:00:00.000',
            currency: 'CNY',
            inputMissFen: 600,
            inputHitFen: 12,
            outputFen: 2500,
            upstreamUsd: null,
            note: null,
          }],
          createTime: '2026-01-01 00:00:00.000',
          updateTime: '2026-01-01 00:00:00.000',
        }],
      }],
      slots: [],
      legacyPrices: [rate('legacy-provider', 'old-model', '2020-01-01 00:00:00.000', 42)],
    };
    const views = ratesFromDocument(document);
    expect(views).toHaveLength(2);
    expect(views.find(view => view.providerId === 'env-default')?.creditInputMiss).toBe(600);
    expect(views.find(view => view.providerId === 'legacy-provider')?.creditInputMiss).toBe(42);
  });
});

describe('Credit 面额', () => {
  it('1 积分 = ¥0.01 是固定面额', () => {
    expect(SELL_UNIT).toEqual({ creditPerYuan: 100, tokensPerMillion: 1_000_000 });
    expect(creditDenominationLabel).toBe('1 积分 = ¥0.01');
    expect(rateCardUnitLabel).toBe('积分 / 1M tokens');
  });
});
