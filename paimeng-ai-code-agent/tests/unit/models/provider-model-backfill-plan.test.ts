import { describe, expect, it } from 'vitest';
import type { ModelAliasCapabilities } from '@/shared/model-config';
import {
  buildProviderModelBackfillPlan,
  type BackfillAliasRow,
  type BackfillInput,
  type BackfillModelRow,
  type BackfillRateRow,
} from '@/server/models/provider-model-backfill-plan';

const capabilities = (overrides: Partial<ModelAliasCapabilities> = {}): ModelAliasCapabilities => ({
  streaming: true,
  toolCalling: true,
  structuredOutput: false,
  imageInput: false,
  ...overrides,
});

function alias(overrides: Partial<BackfillAliasRow> = {}): BackfillAliasRow {
  return {
    alias: 'codegen.default',
    providerId: 'primary',
    modelName: 'same-model',
    capabilities: capabilities(),
    reasoningContentPassthrough: false,
    enabled: true,
    providerModelId: null,
    ...overrides,
  };
}

function model(overrides: Partial<BackfillModelRow> = {}): BackfillModelRow {
  return {
    id: '7001',
    providerId: 'primary',
    upstreamModelName: 'same-model',
    displayName: '主提供商 / same-model',
    capabilities: capabilities(),
    compatibility: { reasoningContentPassthrough: false },
    enabled: true,
    ...overrides,
  };
}

function rate(overrides: Partial<BackfillRateRow> = {}): BackfillRateRow {
  return {
    providerId: 'primary',
    modelName: 'same-model',
    providerModelId: null,
    effectiveFrom: '2026-01-01 00:00:00.000',
    ...overrides,
  };
}

function input(overrides: Partial<BackfillInput> = {}): BackfillInput {
  return {
    state: { revision: '3', refreshEpoch: '2' },
    providers: [{ id: 'primary', displayName: '主提供商', enabled: true }],
    models: [],
    aliases: [alias(), alias({ alias: 'route.classify' })],
    rates: [],
    steps: [],
    ...overrides,
  };
}

describe('提供商模型回填计划', () => {
  it('同组槽位能力一致时生成一条创建动作，并保留两个待关联槽位', () => {
    const plan = buildProviderModelBackfillPlan(input());
    expect(plan.conflicts).toEqual([]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      providerId: 'primary',
      upstreamModelName: 'same-model',
      action: 'create',
      existingModelId: null,
      aliasNames: ['codegen.default', 'route.classify'],
      aliasesToLink: ['codegen.default', 'route.classify'],
      enabled: true,
    });
    expect(plan.counts).toEqual({ modelsToCreate: 1, aliasesToLink: 2, ratesToLink: 0, conflicts: 0 });
  });

  it('能力不一致时只报告冲突，不取并集', () => {
    const plan = buildProviderModelBackfillPlan(input({
      aliases: [alias(), alias({ alias: 'route.classify', capabilities: capabilities({ streaming: false, structuredOutput: true }) })],
    }));
    expect(plan.counts.modelsToCreate).toBe(0);
    expect(plan.counts.aliasesToLink).toBe(0);
    expect(plan.groups[0]?.action).toBe('conflict');
    expect(plan.conflicts[0]).toMatchObject({ reasons: ['capabilities-differ'], aliases: ['codegen.default', 'route.classify'] });
  });

  it('兼容声明不一致时同样中止', () => {
    const plan = buildProviderModelBackfillPlan(input({
      aliases: [alias(), alias({ alias: 'route.classify', reasoningContentPassthrough: true })],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['compatibility-differ']);
    expect(plan.groups[0]?.action).toBe('conflict');
  });

  it('已登记的模型只关联未链接槽位，并且不改模型能力', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model()],
      aliases: [alias({ providerModelId: '7001' }), alias({ alias: 'route.classify' })],
    }));
    expect(plan.groups[0]).toMatchObject({ action: 'link', existingModelId: '7001', aliasesToLink: ['route.classify'] });
    expect(plan.counts).toEqual({ modelsToCreate: 0, aliasesToLink: 1, ratesToLink: 0, conflicts: 0 });
  });

  it('已登记模型的能力或兼容声明不一致时不静默关联', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model({ capabilities: capabilities({ imageInput: true }) })],
      aliases: [alias()],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['model-capabilities-differ']);
    expect(plan.groups[0]?.action).toBe('conflict');
  });

  it('已登记模型停用但槽位仍启用时报告冲突', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model({ enabled: false })],
      aliases: [alias()],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['model-disabled']);
  });

  it('提供商店停用而槽位仍启用时报告冲突', () => {
    const plan = buildProviderModelBackfillPlan(input({
      providers: [{ id: 'primary', displayName: '主提供商', enabled: false }],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['provider-disabled']);
    expect(plan.groups[0]?.action).toBe('conflict');
  });

  it('已登记模型的兼容声明不一致时报告冲突', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model({ compatibility: { reasoningContentPassthrough: true } })],
      aliases: [alias()],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['model-compatibility-differ']);
  });

  it('同一模型的多条费率版本逐条列入计划，错链费率单独报告', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model()],
      aliases: [alias()],
      rates: [
        rate(),
        rate({ effectiveFrom: '2026-02-01 00:00:00.000' }),
        rate({ providerModelId: '9999' }),
      ],
    }));
    expect(plan.rates.linkable[0]).toMatchObject({ versions: 2, effectiveFroms: ['2026-01-01 00:00:00.000', '2026-02-01 00:00:00.000'] });
    expect(plan.rates.mismatched).toEqual([{ providerId: 'primary', modelName: 'same-model', providerModelId: '9999' }]);
    expect(plan.rates.alreadyLinked).toBe(0);
  });

  it('同名不同前缀或大小写不同按原字符串分开', () => {
    const plan = buildProviderModelBackfillPlan(input({
      aliases: [
        alias({ alias: 'codegen.default', modelName: 'Same-Model' }),
        alias({ alias: 'route.classify', modelName: 'same-model' }),
      ],
    }));
    expect(plan.groups.map(group => group.upstreamModelName).sort()).toEqual(['Same-Model', 'same-model']);
    expect(plan.counts.modelsToCreate).toBe(2);
  });

  it('费率只关联精确匹配的模型；计划中的新模型标记 planned', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model()],
      aliases: [alias()],
      rates: [
        rate(),
        rate({ modelName: 'orphan-model' }),
        rate({ providerId: 'other', modelName: 'same-model' }),
      ],
    }));
    expect(plan.rates.linkable).toEqual([{
      providerId: 'primary',
      modelName: 'same-model',
      versions: 1,
      effectiveFroms: ['2026-01-01 00:00:00.000'],
      targetModelId: '7001',
      planned: false,
    }]);
    expect(plan.rates.orphans.map(item => `${item.providerId}/${item.modelName}`)).toEqual(['other/same-model', 'primary/orphan-model']);
    expect(plan.counts.ratesToLink).toBe(1);

    const planned = buildProviderModelBackfillPlan(input({ rates: [rate()] }));
    expect(planned.rates.linkable).toEqual([{
      providerId: 'primary',
      modelName: 'same-model',
      versions: 1,
      effectiveFroms: ['2026-01-01 00:00:00.000'],
      targetModelId: null,
      planned: true,
    }]);
  });

  it('冲突组的费率不参与关联，重复执行计划归零', () => {
    const conflict = buildProviderModelBackfillPlan(input({
      aliases: [alias(), alias({ alias: 'route.classify', capabilities: capabilities({ streaming: false }) })],
      rates: [rate()],
    }));
    expect(conflict.rates.linkable).toEqual([]);
    expect(conflict.rates.orphans[0]).toMatchObject({ reason: 'conflict', versions: 1 });

    const settled = buildProviderModelBackfillPlan(input({
      models: [model()],
      aliases: [alias({ providerModelId: '7001' }), alias({ alias: 'route.classify', providerModelId: '7001' })],
      rates: [rate({ providerModelId: '7001' })],
    }));
    expect(settled.counts).toEqual({ modelsToCreate: 0, aliasesToLink: 0, ratesToLink: 0, conflicts: 0 });
    expect(settled.aliases).toEqual({ total: 2, linked: 2, unlinked: 0 });
    expect(settled.rates.alreadyLinked).toBe(1);
  });

  it('未关联步骤只统计，不产生写入动作', () => {
    const plan = buildProviderModelBackfillPlan(input({
      steps: [
        { providerId: 'primary', modelName: 'same-model', steps: 3 },
        { providerId: 'durable', modelName: 'override-model', steps: 2 },
      ],
    }));
    expect(plan.steps.unlinkedModelSteps).toBe(5);
    expect(plan.steps.keys).toEqual([
      { providerId: 'durable', modelName: 'override-model', steps: 2 },
      { providerId: 'primary', modelName: 'same-model', steps: 3 },
    ]);
    expect(plan.counts).toEqual({ modelsToCreate: 1, aliasesToLink: 2, ratesToLink: 0, conflicts: 0 });
  });

  it('槽位指向别的模型时报告冲突，不覆盖现有链接', () => {
    const plan = buildProviderModelBackfillPlan(input({
      models: [model(), model({ id: '7002', providerId: 'secondary' })],
      aliases: [alias({ providerModelId: '7002' })],
    }));
    expect(plan.conflicts[0]?.reasons).toEqual(['alias-linked-elsewhere']);
    expect(plan.groups[0]?.aliasesToLink).toEqual([]);
  });
});
