import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  rateCardColumns,
  rateCardInputSchema,
  rateCardUnit,
  type RateCardInput,
  type RateCardList,
  type RateCardView,
} from '@/shared/billing';
import { db, now, type Transaction } from '../infra/db';
import { BusinessError } from '../infra/http';
import { creditRateCard, providerModels } from '../infra/schema';

/**
 * 费率表：读取、按时刻解析、管理员追加版本。
 *
 * 解析严格按 (provider_id, model_name) 匹配，未命中返回 null —— 调用方据此把 Charge 标成
 * `unpriced`。这里不做模型名回退、不猜提供商、也不回退到任何常量价：generation_step.provider_id
 * 在环境变量覆盖时是 `durable`、夹具里是 `fixture`、重挂接解析失败时可能是 NULL，猜出来的价
 * 会直接变成错的账单。
 */

/** 面额常量的唯一定义在 `@/shared/billing`，这里转出给服务端调用方。 */
export { SELL_UNIT } from '@/shared/billing';

/** 全库时间列都是 UTC 朴素时间戳；换算成毫秒比较，避免毫秒位数不同（有无 `.000`）导致误判。 */
function instantOf(timestamp: string): number {
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`);
}

/**
 * 取 `at` 时刻生效的版本：同一 (providerId, modelName) 里 `effective_from <= at` 的最新一条。
 * 未来版本不会提前生效；没有匹配返回 null。
 */
function latestAt(rates: readonly RateCardView[], at: string, matches: (rate: RateCardView) => boolean): RateCardView | null {
  const atMs = instantOf(at);
  if (Number.isNaN(atMs)) return null;
  let matched: RateCardView | null = null;
  let matchedMs = Number.NEGATIVE_INFINITY;
  for (const rate of rates) {
    if (!matches(rate)) continue;
    const effectiveMs = instantOf(rate.effectiveFrom);
    if (Number.isNaN(effectiveMs) || effectiveMs > atMs) continue;
    if (effectiveMs > matchedMs) {
      matched = rate;
      matchedMs = effectiveMs;
    }
  }
  return matched;
}

export function resolveRate(
  rates: readonly RateCardView[],
  providerId: string | null,
  modelName: string | null,
  at: string,
): RateCardView | null {
  if (!providerId || !modelName) return null;
  return latestAt(rates, at, rate => rate.providerId === providerId && rate.modelName === modelName);
}

/** 新步骤只按稳定模型 ID 取价；ID 查不到就是待处理，不回退到响应名或当前槽位。 */
export function resolveRateById(rates: readonly RateCardView[], providerModelId: string | null, at: string): RateCardView | null {
  if (!providerModelId) return null;
  return latestAt(rates, at, rate => rate.providerModelId === providerModelId);
}

/**
 * 全部版本，按 provider / model 升序、版本由新到旧，与 idx_credit_rate_card_model 的顺序一致。
 * 传事务句柄时在结算事务里读：费率必须与这次 Charge 的快照出自同一个可见性快照。
 */
export async function readRates(tx?: Transaction): Promise<RateCardView[]> {
  const rows = await (tx ?? db())
    .select()
    .from(creditRateCard)
    .orderBy(asc(creditRateCard.providerId), asc(creditRateCard.modelName), desc(creditRateCard.effectiveFrom));
  return rows.map(rateCardViewOf);
}

/**
 * 管理界面的读模型：全部版本 + 三列顺序 + 单位文案 + 每个 (provider, model) 此刻生效的版本。
 * 「此刻生效」走的是与结算同一个 resolveRate，界面只据此打标签，不自己再算一遍。
 */
export async function readRateCardList(at: string = now()): Promise<RateCardList> {
  const rates = await readRates();
  const models = new Map<string, RateCardView[]>();
  for (const rate of rates) {
    const key = rate.providerModelId ? `model:${rate.providerModelId}` : `${rate.providerId}\u0000${rate.modelName}`;
    const group = models.get(key);
    if (group) group.push(rate);
    else models.set(key, [rate]);
  }
  const effectiveNow: RateCardList['effectiveNow'] = [];
  for (const group of models.values()) {
    const first = group[0];
    const current = first.providerModelId
      ? resolveRateById(group, first.providerModelId, at)
      : resolveRate(group, first.providerId, first.modelName, at);
    if (current) {
      effectiveNow.push({
        providerId: current.providerId,
        modelName: current.modelName,
        providerModelId: current.providerModelId ?? null,
        effectiveFrom: current.effectiveFrom,
      });
    }
  }
  return { rates, columns: [...rateCardColumns], unit: rateCardUnit, effectiveNow };
}

/** 管理员 payload 的严格校验：负数、全零、非法生效时间都在这里被拒（ZodError → 400/40000）。 */
export function validateRateInput(input: unknown): RateCardInput {
  return rateCardInputSchema.parse(input);
}

/**
 * 追加一个费率版本。历史行永不修改：改价就是给同一模型写一个更晚的 effective_from。
 * 相同 (provider_id, model_name, effective_from) 由主键挡下，转成可读的 409。
 */
export async function appendRate(input: unknown, createdBy: string): Promise<RateCardView> {
  const parsed = validateRateInput(input);
  let identity: { providerId: string; modelName: string; providerModelId: string | null };
  if ('providerModelId' in parsed) {
    const [model] = await db().select().from(providerModels).where(eq(providerModels.id, BigInt(parsed.providerModelId))).limit(1);
    if (!model) throw new BusinessError(404, 40400, `提供商模型 ${parsed.providerModelId} 不存在`);
    identity = { providerId: model.providerId, modelName: model.upstreamModelName, providerModelId: parsed.providerModelId };
  } else {
    // 过渡写法：P5 切换管理界面后删除。已登记的模型只允许补历史价，避免同时维护两套当前价。
    const [linked] = await db()
      .select({ id: providerModels.id })
      .from(providerModels)
      .where(and(eq(providerModels.providerId, parsed.providerId), eq(providerModels.upstreamModelName, parsed.modelName)))
      .limit(1);
    if (linked && instantOf(parsed.effectiveFrom) >= Date.now()) {
      throw new BusinessError(
        409,
        40900,
        `提供商 ${parsed.providerId} 已登记请求模型 ${parsed.modelName}；追加当前或未来费率请使用模型 ID，历史补价请填过去的生效时间`,
      );
    }
    identity = { providerId: parsed.providerId, modelName: parsed.modelName, providerModelId: null };
  }
  const fields = {
    effectiveFrom: parsed.effectiveFrom,
    creditInputMiss: parsed.creditInputMiss,
    creditInputHit: parsed.creditInputHit,
    creditOutput: parsed.creditOutput,
    usdInputMiss: parsed.usdInputMiss,
    usdInputHit: parsed.usdInputHit,
    usdOutput: parsed.usdOutput,
    costBasis: parsed.costBasis,
    costSource: parsed.costSource,
    note: parsed.note,
  };
  try {
    const [row] = await db()
      .insert(creditRateCard)
      .values({ ...fields, providerId: identity.providerId, modelName: identity.modelName, providerModelId: identity.providerModelId === null ? null : BigInt(identity.providerModelId), createdBy: BigInt(createdBy), createTime: now() })
      .returning();
    return rateCardViewOf(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      const target = identity.providerModelId ? `提供商模型 ${identity.providerModelId}` : `${identity.providerId} / ${identity.modelName}`;
      throw new BusinessError(409, 40900, `${target} 在 ${parsed.effectiveFrom} 已有一个版本；改价请填一个更晚的生效时间`);
    }
    throw error;
  }
}

/** drizzle 把 SQL 错误包在 cause 里，主键冲突的 23505 要顺着 cause 链找。 */
function uniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: string }).code === '23505') return true;
  }
  return false;
}

/** Postgres 在毫秒为 0 时省略 `.000`；DTO 只保留一种时间格式，补齐成 3 位。 */
function fixedMillis(timestamp: string): string {
  return timestamp.length === 19 ? `${timestamp}.000` : timestamp;
}

function rateCardViewOf(row: typeof creditRateCard.$inferSelect): RateCardView {
  return {
    providerId: row.providerId,
    modelName: row.modelName,
    providerModelId: row.providerModelId === null ? null : row.providerModelId.toString(),
    effectiveFrom: fixedMillis(row.effectiveFrom),
    creditInputMiss: row.creditInputMiss,
    creditInputHit: row.creditInputHit,
    creditOutput: row.creditOutput,
    usdInputMiss: row.usdInputMiss ?? null,
    usdInputHit: row.usdInputHit ?? null,
    usdOutput: row.usdOutput ?? null,
    costBasis: row.costBasis ?? null,
    costSource: row.costSource ?? null,
    note: row.note ?? null,
    createdBy: row.createdBy === null ? null : String(row.createdBy),
    createTime: fixedMillis(row.createTime),
  };
}
