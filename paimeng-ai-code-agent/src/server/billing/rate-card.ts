import 'server-only';
import type { RateCardView } from '@/shared/billing';
import { modelPriceVersionSchema, type ModelConfigDocument, type ModelPriceVersion } from '@/shared/model-document';
import type { Transaction } from '../infra/db';
import { readModelConfigDocument } from '../models/store';

/**
 * 费率来源：模型配置 JSON 里的价格版本（+ 迁移遗留的孤儿价格）。
 *
 * 解析严格按 (provider_id, model_name) 匹配，未命中返回 null —— 调用方据此把 Charge 标成
 * `unpriced`。这里不做模型名回退、不猜提供商、也不回退到任何常量价：generation_step.provider_id
 * 在环境变量覆盖时是 `durable`、夹具里是 `fixture`、重挂接解析失败时可能是 NULL，猜出来的价
 * 会直接变成错的账单。
 */

export { SELL_UNIT } from '@/shared/billing';

/** 全库时间列都是 UTC 朴素时间戳；换算成毫秒比较，避免毫秒位数不同（有无 `.000`）导致误判。 */
function instantOf(timestamp: string): number {
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`);
}

/**
 * 取 `at` 时刻生效的版本：同一 (providerId, modelName) 里 `effective_from <= at` 的最新一条。
 * 未来版本不会提前生效；没有匹配返回 null。
 */
export function resolveRate(
  rates: readonly RateCardView[],
  providerId: string | null,
  modelName: string | null,
  at: string,
): RateCardView | null {
  if (!providerId || !modelName) return null;
  const atMs = instantOf(at);
  if (Number.isNaN(atMs)) return null;
  let matched: RateCardView | null = null;
  let matchedMs = Number.NEGATIVE_INFINITY;
  for (const rate of rates) {
    if (rate.providerId !== providerId || rate.modelName !== modelName) continue;
    const effectiveMs = instantOf(rate.effectiveFrom);
    if (Number.isNaN(effectiveMs) || effectiveMs > atMs) continue;
    if (effectiveMs > matchedMs) {
      matched = rate;
      matchedMs = effectiveMs;
    }
  }
  return matched;
}

/** Postgres 在毫秒为 0 时省略 `.000`；DTO 只保留一种时间格式，补齐成 3 位。 */
function fixedMillis(timestamp: string): string {
  return timestamp.length === 19 ? `${timestamp}.000` : timestamp;
}

/** JSON 单价（分 / 1M tokens）直接就是 Credit；1 分 = 1 Credit。 */
export function rateViewOfPrice(providerId: string, modelName: string, raw: ModelPriceVersion): RateCardView {
  const price = modelPriceVersionSchema.parse(raw);
  const usd = price.upstreamUsd;
  const hasUsd = Boolean(usd && (usd.inputMiss !== null || usd.inputHit !== null || usd.output !== null));
  return {
    providerId,
    modelName,
    effectiveFrom: fixedMillis(price.effectiveAt),
    creditInputMiss: price.inputMissFen,
    creditInputHit: price.inputHitFen,
    creditOutput: price.outputFen,
    usdInputMiss: usd?.inputMiss ?? null,
    usdInputHit: usd?.inputHit ?? null,
    usdOutput: usd?.output ?? null,
    costBasis: price.costBasis ?? (hasUsd ? 'unknown' : null),
    costSource: price.costSource ?? null,
    note: price.note,
    createdBy: null,
    createTime: fixedMillis(price.effectiveAt),
  };
}

/** 从 JSON 文档展开成结算沿用的费率视图（含未来版本；是否生效由 resolveRate 判断）。 */
export function ratesFromDocument(document: ModelConfigDocument): RateCardView[] {
  const rates: RateCardView[] = [];
  for (const provider of document.providers) {
    for (const model of provider.models) {
      for (const price of model.prices) rates.push(rateViewOfPrice(provider.id, model.upstream, price));
    }
  }
  for (const legacy of document.legacyPrices) {
    rates.push({
      providerId: legacy.providerId,
      modelName: legacy.modelName,
      effectiveFrom: fixedMillis(legacy.effectiveFrom),
      creditInputMiss: legacy.creditInputMiss,
      creditInputHit: legacy.creditInputHit,
      creditOutput: legacy.creditOutput,
      usdInputMiss: legacy.usdInputMiss,
      usdInputHit: legacy.usdInputHit,
      usdOutput: legacy.usdOutput,
      costBasis: legacy.costBasis,
      costSource: legacy.costSource,
      note: legacy.note,
      createdBy: legacy.createdBy,
      createTime: fixedMillis(legacy.createTime || legacy.effectiveFrom),
    });
  }
  return rates.sort((left, right) =>
    left.providerId.localeCompare(right.providerId)
    || left.modelName.localeCompare(right.modelName)
    || instantOf(right.effectiveFrom) - instantOf(left.effectiveFrom));
}

/**
 * 全部版本，按 provider / model 升序、版本由新到旧。
 * 传事务句柄时在结算事务里读：价格必须与这次 Charge 的快照出自同一个可见性快照。
 */
export async function readRates(tx?: Transaction): Promise<RateCardView[]> {
  return ratesFromDocument(await readModelConfigDocument(tx));
}
