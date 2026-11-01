import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { eq, like } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import {
  creditCharges,
  creditEntries,
  creditRateCard,
  modelAliases,
  modelConfigState,
  modelProviders,
  providerModels,
} from '@/server/infra/schema';
import { modelConfigStateId, type ModelAliasCapabilities } from '@/shared/model-config';
import { applyProviderModelBackfill, planProviderModelBackfill } from '@/server/models/provider-model-backfill';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const prefix = 'bf_test_';
const capabilities: ModelAliasCapabilities = { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false };
const otherCapabilities: ModelAliasCapabilities = { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false };
const billingIds: { chargeId: string; generationId: string }[] = [];

async function resetModelConfig() {
  await db().delete(modelAliases);
  await db().delete(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`));
  await db().delete(providerModels);
  await db().delete(modelProviders);
  for (const ids of billingIds.splice(0)) {
    await db().delete(creditEntries).where(eq(creditEntries.chargeId, ids.chargeId));
    await db().delete(creditCharges).where(eq(creditCharges.generationId, ids.generationId));
  }
  await db()
    .insert(modelConfigState)
    .values({ id: modelConfigStateId, revision: 0n, refreshEpoch: 0n, updateTime: now() })
    .onConflictDoUpdate({ target: modelConfigState.id, set: { revision: 0n, refreshEpoch: 0n, updateTime: now() } });
}

async function seedProvider(id: string, displayName = id) {
  await db().insert(modelProviders).values({
    id,
    displayName,
    apiFormat: 'openai-chat',
    baseUrl: `https://${id}.example.test/v1`,
    apiKeyEnv: 'AI_API_KEY',
    options: {},
    enabled: 1,
    createTime: now(),
    updateTime: now(),
  });
}

async function seedAlias(alias: string, providerId: string, modelName: string, caps: ModelAliasCapabilities, settings: Record<string, unknown> = {}, providerModelId: string | null = null) {
  await db().insert(modelAliases).values({
    alias,
    providerId,
    modelName,
    providerModelId: providerModelId === null ? null : BigInt(providerModelId),
    capabilities: caps,
    settings,
    enabled: 1,
    createTime: now(),
    updateTime: now(),
  });
}

async function seedRate(providerId: string, modelName: string, effectiveFrom = '2026-01-01 00:00:00.000') {
  await db().insert(creditRateCard).values({
    providerId,
    modelName,
    effectiveFrom,
    creditInputMiss: 1,
    creditInputHit: 1,
    creditOutput: 1,
    costBasis: 'unknown',
    createTime: now(),
  });
}

async function seedModel(id: string, providerId: string, modelName: string, caps: ModelAliasCapabilities, enabled = true) {
  await db().insert(providerModels).values({
    id: BigInt(id),
    providerId,
    upstreamModelName: modelName,
    displayName: `${providerId} / ${modelName}`,
    capabilities: caps,
    compatibility: { reasoningContentPassthrough: false },
    enabled: enabled ? 1 : 0,
    createTime: now(),
    updateTime: now(),
  });
}

async function seedRequiredAliases(providerId: string, caps = capabilities) {
  await seedAlias('codegen.default', providerId, 'same-model', caps);
  await seedAlias('route.classify', providerId, 'same-model', caps);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', 'scripts/db/backfill-provider-models.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(process.env.DATABASE_URL ?? '') },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
}

describe('提供商模型回填', () => {
  beforeEach(async () => {
    await resetModelConfig();
  });

  afterAll(async () => {
    await resetModelConfig();
    await getPool().end();
  });

  it('dry-run 零写入；apply 创建模型、关联槽位与精确费率；重复执行无变更', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedRequiredAliases('bf_test_primary');
    await seedRate('bf_test_primary', 'same-model');
    await seedRate('bf_test_primary', 'orphan-model');

    const plan = await planProviderModelBackfill();
    expect(plan.expectedRevision).toBe('0');
    expect(plan.counts).toEqual({ modelsToCreate: 1, aliasesToLink: 2, ratesToLink: 1, conflicts: 0 });
    expect(plan.rates.linkable).toEqual([{
      providerId: 'bf_test_primary',
      modelName: 'same-model',
      versions: 1,
      effectiveFroms: ['2026-01-01 00:00:00.000'],
      targetModelId: null,
      planned: true,
    }]);
    expect(plan.rates.orphans).toContainEqual({ providerId: 'bf_test_primary', modelName: 'orphan-model', versions: 1, reason: 'no-model' });

    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(0);
    const aliasesBefore = await db().select({ alias: modelAliases.alias, providerModelId: modelAliases.providerModelId }).from(modelAliases).where(like(modelAliases.providerId, `${prefix}%`));
    expect(aliasesBefore).toHaveLength(2);
    expect(aliasesBefore.every(alias => alias.providerModelId === null)).toBe(true);
    const ratesBefore = await db().select({ modelName: creditRateCard.modelName, providerModelId: creditRateCard.providerModelId }).from(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`));
    expect(ratesBefore).toHaveLength(2);
    expect(ratesBefore.every(rate => rate.providerModelId === null)).toBe(true);
    expect((await db().select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)))[0]?.revision.toString()).toBe('0');

    const applied = await applyProviderModelBackfill(plan.expectedRevision);
    expect(applied).toMatchObject({ createdModels: 1, linkedAliases: 2, linkedRates: 1, revision: '1', refreshEpoch: '1', changed: true });

    const [storedModel] = await db().select().from(providerModels).where(eq(providerModels.providerId, 'bf_test_primary'));
    expect(storedModel).toMatchObject({
      upstreamModelName: 'same-model',
      displayName: '主提供商 / same-model',
      capabilities,
      compatibility: { reasoningContentPassthrough: false },
      enabled: 1,
    });
    const aliasesAfter = await db().select({ alias: modelAliases.alias, providerModelId: modelAliases.providerModelId }).from(modelAliases).where(like(modelAliases.providerId, `${prefix}%`));
    expect(aliasesAfter.every(alias => alias.providerModelId?.toString() === storedModel?.id.toString())).toBe(true);
    const ratesAfter = await db().select({ modelName: creditRateCard.modelName, providerModelId: creditRateCard.providerModelId }).from(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`));
    expect(ratesAfter.find(rate => rate.modelName === 'same-model')?.providerModelId?.toString()).toBe(storedModel?.id.toString());
    expect(ratesAfter.find(rate => rate.modelName === 'orphan-model')?.providerModelId).toBeNull();

    const secondPlan = await planProviderModelBackfill();
    expect(secondPlan.counts).toEqual({ modelsToCreate: 0, aliasesToLink: 0, ratesToLink: 0, conflicts: 0 });
    const replayed = await applyProviderModelBackfill('1');
    expect(replayed).toMatchObject({ createdModels: 0, linkedAliases: 0, linkedRates: 0, revision: '1', refreshEpoch: '1', changed: false });
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(1);
  });

  it('预检后配置版本变化时中止，不写入', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedRequiredAliases('bf_test_primary');
    const plan = await planProviderModelBackfill();
    await db().update(modelConfigState).set({ revision: 5n, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));

    await expect(applyProviderModelBackfill(plan.expectedRevision)).rejects.toMatchObject({ status: 409, code: 40901 });
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(0);
    expect(await db().select().from(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`))).toHaveLength(0);
  });

  it('能力冲突时整批中止，不创建、不关联', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedAlias('codegen.default', 'bf_test_primary', 'same-model', capabilities);
    await seedAlias('route.classify', 'bf_test_primary', 'same-model', otherCapabilities);
    await seedRate('bf_test_primary', 'same-model');

    const plan = await planProviderModelBackfill();
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ reasons: ['capabilities-differ'] });
    expect(plan.counts).toEqual({ modelsToCreate: 0, aliasesToLink: 0, ratesToLink: 0, conflicts: 1 });
    expect(plan.rates.orphans).toContainEqual({ providerId: 'bf_test_primary', modelName: 'same-model', versions: 1, reason: 'conflict' });

    await expect(applyProviderModelBackfill(plan.expectedRevision)).rejects.toMatchObject({ status: 409, code: 40905 });
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(0);
    const aliases = await db().select({ providerModelId: modelAliases.providerModelId }).from(modelAliases).where(like(modelAliases.providerId, `${prefix}%`));
    expect(aliases.every(alias => alias.providerModelId === null)).toBe(true);
    const rates = await db().select({ providerModelId: creditRateCard.providerModelId }).from(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`));
    expect(rates.every(rate => rate.providerModelId === null)).toBe(true);
    expect((await db().select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)))[0]?.revision.toString()).toBe('0');
  });

  it('关联既有模型时不改写账单与分录', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedModel('7001', 'bf_test_primary', 'same-model', capabilities);
    await seedAlias('codegen.default', 'bf_test_primary', 'same-model', capabilities);
    await seedRate('bf_test_primary', 'same-model');

    const generationId = randomUUID();
    const chargeId = randomUUID();
    billingIds.push({ chargeId, generationId });
    await db().insert(creditCharges).values({
      generationId,
      appId: 1n,
      userId: 2n,
      credits: 10,
      costUsd: '0.001000',
      rateCardSnapshot: [],
      usageSnapshot: [],
      status: 'settled',
      estimatedSteps: 0,
      createTime: now(),
    });
    await db().insert(creditEntries).values({ chargeId, pool: 'balance', credits: 10, createTime: now() });
    const chargesBefore = await db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId));
    const entriesBefore = await db().select().from(creditEntries).where(eq(creditEntries.chargeId, chargeId));

    const plan = await planProviderModelBackfill();
    expect(plan.groups[0]).toMatchObject({ action: 'link', existingModelId: '7001' });
    expect(plan.counts.modelsToCreate).toBe(0);
    const applied = await applyProviderModelBackfill(plan.expectedRevision);
    expect(applied).toMatchObject({ createdModels: 0, linkedAliases: 1, linkedRates: 1, changed: true });

    const aliases = await db().select({ providerModelId: modelAliases.providerModelId }).from(modelAliases).where(like(modelAliases.providerId, `${prefix}%`));
    expect(aliases.map(alias => alias.providerModelId?.toString())).toEqual(['7001']);
    expect(await db().select().from(creditCharges).where(eq(creditCharges.generationId, generationId))).toEqual(chargesBefore);
    expect(await db().select().from(creditEntries).where(eq(creditEntries.chargeId, chargeId))).toEqual(entriesBefore);
  });

  it('只有费率待关联时不递增配置版本，重复执行无变更', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedModel('7001', 'bf_test_primary', 'same-model', capabilities);
    await seedAlias('codegen.default', 'bf_test_primary', 'same-model', capabilities, {}, '7001');
    await seedRate('bf_test_primary', 'same-model');

    const plan = await planProviderModelBackfill();
    expect(plan.counts).toEqual({ modelsToCreate: 0, aliasesToLink: 0, ratesToLink: 1, conflicts: 0 });
    const applied = await applyProviderModelBackfill(plan.expectedRevision);
    expect(applied).toMatchObject({ createdModels: 0, linkedAliases: 0, linkedRates: 1, revision: '0', refreshEpoch: '0', changed: true });
    expect((await db().select().from(modelConfigState).where(eq(modelConfigState.id, modelConfigStateId)))[0]?.revision.toString()).toBe('0');

    const replay = await applyProviderModelBackfill('0');
    expect(replay).toMatchObject({ linkedRates: 0, changed: false, revision: '0', refreshEpoch: '0' });
  });

  it('同一模型的多条费率版本全部关联，大小写与后缀变体保持未关联', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedModel('7001', 'bf_test_primary', 'same-model', capabilities);
    await seedAlias('codegen.default', 'bf_test_primary', 'same-model', capabilities, {}, '7001');
    await seedRate('bf_test_primary', 'same-model', '2026-01-01 00:00:00.000');
    await seedRate('bf_test_primary', 'same-model', '2026-02-01 00:00:00.000');
    await seedRate('bf_test_primary', 'Same-Model');
    await seedRate('bf_test_primary', 'same-model#x');

    const plan = await planProviderModelBackfill();
    expect(plan.rates.linkable).toHaveLength(1);
    expect(plan.rates.linkable[0]).toMatchObject({ versions: 2, effectiveFroms: ['2026-01-01 00:00:00.000', '2026-02-01 00:00:00.000'] });
    expect(plan.rates.orphans.filter(rate => rate.providerId === 'bf_test_primary').map(rate => rate.modelName).sort()).toEqual(['Same-Model', 'same-model#x']);
    const applied = await applyProviderModelBackfill(plan.expectedRevision);
    expect(applied.linkedRates).toBe(2);

    const rows = await db().select({ modelName: creditRateCard.modelName, effectiveFrom: creditRateCard.effectiveFrom, providerModelId: creditRateCard.providerModelId })
      .from(creditRateCard).where(like(creditRateCard.providerId, `${prefix}%`));
    expect(rows.filter(row => row.modelName === 'same-model').every(row => row.providerModelId?.toString() === '7001')).toBe(true);
    expect(rows.filter(row => row.modelName !== 'same-model').every(row => row.providerModelId === null)).toBe(true);
  });

  it('CLI 预检后版本变化时退出 2 并提示重新预检', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedRequiredAliases('bf_test_primary');
    const dryRun = await runCli([]);
    expect(dryRun.code).toBe(0);
    await db().update(modelConfigState).set({ revision: 1n, updateTime: now() }).where(eq(modelConfigState.id, modelConfigStateId));

    const stale = await runCli(['--apply', '--expect-revision', '0']);
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('配置在预检后已变化');
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(0);
  });

  it('CLI 冲突 dry-run 退出 2，带正确版本 apply 退出 0', async () => {
    await seedProvider('bf_test_primary', '主提供商');
    await seedRequiredAliases('bf_test_primary');

    const dryRun = await runCli([]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain('"expectedRevision": "0"');

    const applied = await runCli(['--apply', '--expect-revision', '0']);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('关联槽位 2');
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(1);

    await resetModelConfig();
    await seedProvider('bf_test_primary', '主提供商');
    await seedAlias('codegen.default', 'bf_test_primary', 'same-model', capabilities);
    await seedAlias('route.classify', 'bf_test_primary', 'same-model', otherCapabilities);
    const conflict = await runCli([]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain('存在冲突');
    expect(await db().select().from(providerModels).where(like(providerModels.providerId, `${prefix}%`))).toHaveLength(0);
  });
});
