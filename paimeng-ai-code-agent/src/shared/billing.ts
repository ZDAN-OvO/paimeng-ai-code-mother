import { z } from 'zod';
import { idSchema, type GenerationStatus, type GenerationStopReason } from './contracts';

/**
 * 计费共享契约（决策见 `docs/adr/0004-credit-billing.md`）：client 与 server 都要用的 DTO、zod schema 与展示标签。
 * 只追加、不重排——87（Rate card）、89（Charge）、92（Admin 用量）各自往这里加自己的段落。
 * 这里不许 import `server-only` 或 drizzle：它同时被浏览器打包。
 */

// ---- Rate card（migrations/008_credit_rate_card.sql）----

/**
 * 1 Credit = ¥0.01 是不可变承诺：改价只能改 Rate card 里的费率，不能改面额，
 * 否则每一条历史 Credit charge 的语义都会跟着变。
 */
export const SELL_UNIT = { creditPerYuan: 100, tokensPerMillion: 1_000_000 } as const;

/** 费率的单位文案：接口响应与后台界面都读这一处，不在两边各写一遍。 */
export const rateCardUnitLabel = 'Credit / 1M tokens';

/** 面额文案由 SELL_UNIT 推出，改面额时文案自动跟随。 */
export const creditDenominationLabel = `1 Credit = ¥${(1 / SELL_UNIT.creditPerYuan).toFixed(2)}`;

/** 上游成本口径：峰时/谷时价才可追溯，不知道就记 unknown，不拿售价折算。 */
export const costBases = ['peak', 'off-peak', 'unknown'] as const;
export type CostBasis = (typeof costBases)[number];
export const costBasisLabels: Record<CostBasis, string> = {
  peak: '上游峰时价',
  'off-peak': '上游谷时价',
  unknown: '上游成本未知',
};

/** 三个计费列的顺序只在这里定义一次，接口与界面都按它排列。 */
export const rateCardColumns = [
  { key: 'creditInputMiss', label: '缓存未命中输入' },
  { key: 'creditInputHit', label: '缓存命中输入' },
  { key: 'creditOutput', label: '输出' },
] as const satisfies readonly { key: RateCardCreditKey; label: string }[];

export type RateCardCreditKey = 'creditInputMiss' | 'creditInputHit' | 'creditOutput';
export type RateCardColumn = { key: RateCardCreditKey; label: string };

/** 费率单位与面额随数据一起返回，界面不必再从注释里猜单位。 */
export const rateCardUnit = {
  creditPerYuan: SELL_UNIT.creditPerYuan,
  tokensPerMillion: SELL_UNIT.tokensPerMillion,
  rateLabel: rateCardUnitLabel,
  denominationLabel: creditDenominationLabel,
} as const;

/** 全库时间列都是 UTC 朴素时间戳，生效时间沿用同一格式，可直接落 TIMESTAMP(3)。 */
const naiveTimestamp = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u, '生效时间必须形如 2026-10-01 00:00:00.000（UTC）')
  .refine((value) => !Number.isNaN(Date.parse(`${value.replace(' ', 'T')}Z`)), '生效时间不是合法时刻');

const creditRate = z.number().int('费率必须是整数 Credit').min(0, '费率不能是负数');

/** 上游成本是可空的定点字符串，最多 6 位小数；空值表示未知，不用 0 代替。 */
const optionalUsdRate = z
  .union([z.null(), z.string().trim().regex(/^\d+(?:\.\d{1,6})?$/u, '上游成本是 USD / 1M tokens，最多 6 位小数')])
  .optional()
  .transform((value) => value ?? null);

// 界面把留空的可选文本送成 null，所以是 nullish；只接受 undefined 会让「不填备注」直接 400。
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const rateCardInputSchema = z
  .object({
    providerId: z.string().trim().min(1, '提供商不能为空').max(64),
    modelName: z.string().trim().min(1, '模型不能为空').max(256),
    effectiveFrom: naiveTimestamp,
    creditInputMiss: creditRate,
    creditInputHit: creditRate,
    creditOutput: creditRate,
    usdInputMiss: optionalUsdRate,
    usdInputHit: optionalUsdRate,
    usdOutput: optionalUsdRate,
    // 界面留空时送 null（「成本未知」），所以是 nullish 而不是 optional：optional 只接受 undefined。
    costBasis: z
      .enum(costBases, '成本口径只能是 peak / off-peak / unknown')
      .nullish()
      .transform((value) => value ?? null),
    costSource: optionalText(512),
    note: optionalText(2000),
  })
  .refine(
    (value) => value.creditInputMiss > 0 || value.creditInputHit > 0 || value.creditOutput > 0,
    '三个费率不能同时为 0：那会让这个模型的每次生成都收 0 Credit',
  );

export type RateCardInput = z.infer<typeof rateCardInputSchema>;

export const rateCardViewSchema = z.object({
  providerId: z.string(),
  modelName: z.string(),
  effectiveFrom: z.string(),
  creditInputMiss: z.number().int(),
  creditInputHit: z.number().int(),
  creditOutput: z.number().int(),
  usdInputMiss: z.string().nullable(),
  usdInputHit: z.string().nullable(),
  usdOutput: z.string().nullable(),
  costBasis: z.enum(costBases).nullable(),
  costSource: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createTime: z.string(),
});

export type RateCardView = z.infer<typeof rateCardViewSchema>;

/** 一个费率版本的地址：表的主键，也是结算快照里用来回指历史价格的那把键。 */
export const rateCardVersionKeySchema = z.object({
  providerId: z.string(),
  modelName: z.string(),
  effectiveFrom: z.string(),
});

export type RateCardVersionKey = z.infer<typeof rateCardVersionKeySchema>;

export const rateCardListSchema = z.object({
  rates: z.array(rateCardViewSchema),
  columns: z.array(z.object({ key: z.enum(['creditInputMiss', 'creditInputHit', 'creditOutput']), label: z.string() })),
  unit: z.object({
    creditPerYuan: z.number(),
    tokensPerMillion: z.number(),
    rateLabel: z.string(),
    denominationLabel: z.string(),
  }),
  /** 每个 (provider, model) 此刻生效的版本，由服务端解析规则判定，界面只据此打标签。 */
  effectiveNow: z.array(rateCardVersionKeySchema),
});

export type RateCardList = z.infer<typeof rateCardListSchema>;

// ---- Credit pool 与 Credit grant（migrations/010_credit_grant_account.sql）----

/** Credit pool：配额池按周期发放并重置，余额池由购买或发放而来且不重置；扣减总是先配额池、后余额池。 */
export const creditPools = ['quota', 'balance'] as const;
export type CreditPool = typeof creditPools[number];
export const creditPoolSchema = z.enum(creditPools);

/** Credit grant 的来源：只有 purchase 计入 Overdraft 基数。 */
export const grantSources = ['purchase', 'admin_grant', 'monthly_quota'] as const;
export type GrantSource = typeof grantSources[number];
export const grantSourceSchema = z.enum(grantSources);

export const poolLabels: Record<CreditPool, string> = { quota: '配额池', balance: '余额池' };
export const sourceLabels: Record<GrantSource, string> = { purchase: '购买', admin_grant: '管理员补偿', monthly_quota: '月度配额' };

/** 单笔手工发放上限：挡住表单里多打一个零变成巨额入账。 */
export const maxGrantCredits = 1_000_000;

/** 来源决定池；`credit_grant_pool_of_source` 这个数据库 CHECK 是同一规则的另一处表达。 */
export function poolOfSource(source: GrantSource): CreditPool {
  return source === 'monthly_quota' ? 'quota' : 'balance';
}

/**
 * `POST admin/billing/grant` 的请求体。requestId 是幂等键：同一次提交的重试复用它，成功后才换新的。
 * `pool` 可省略——来源决定池（`poolOfSource`），带上来只作为一致性校验，界面不必自己维护第二份映射。
 */
export const grantRequestSchema = z.object({
  userId: idSchema,
  pool: creditPoolSchema.optional(),
  credits: z.number().refine(
    value => Number.isInteger(value) && value >= 1 && value <= maxGrantCredits,
    `发放金额必须是 1 到 ${maxGrantCredits} 之间的整数 Credit`,
  ),
  source: grantSourceSchema,
  note: z.string().trim().max(500).optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;

/**
 * 发放接口的回执：`created=false` 表示这次是重放，账本没有新增行。
 * `grant` 是服务端刚落库（或重放命中的）那一行的完整视图——时间、操作人、池与来源都来自账本，
 * 界面不再用浏览器时钟或表单值拼一份回执。
 */
export type GrantReceipt = { created: boolean; grant: CreditGrantView };

/** 一笔 Credit grant 的可追溯形状，管理界面的发放回执用它展示。 */
export type CreditGrantView = {
  id: string;
  userId: string;
  pool: CreditPool;
  credits: number;
  source: GrantSource;
  note: string | null;
  requestId: string | null;
  grantedBy: string | null;
  period: string | null;
  createTime: string;
};

/** `GET billing/summary`：Owner 自己的双池余额、近 60 天购买额与由此推导的透支线。 */
export type AccountSnapshot = {
  quota: number;
  balance: number;
  total: number;
  purchasedCredits60d: number;
  overdraft: number;
};

// ---- 月度配额（migrations/010_credit_grant_account.sql 的 (user_id, period) 唯一索引）----

/** 每个北京自然月发放到配额池的 Credit。配额不累积、不结转、不折现，过期即失效。 */
export const monthlyQuotaCredits = 500;

/**
 * `GET billing/summary` 的响应：双池快照 + 这份配额属于哪个账期、什么时候失效。
 * `period` 是北京自然月 `YYYY-MM`（`billing/period.ts`）；`quotaExpiresAt` 是账期半开区间的终点，
 * UTC 朴素时间戳，界面按北京时间显示。
 */
export type AccountSummary = AccountSnapshot & {
  period: string;
  quotaExpiresAt: string;
  /** 当期基础发放、调整净额与已用，界面据此解释配额池余额，不再假设固定 500。 */
  quotaBase: number;
  quotaAdjustments: number;
  quotaUsed: number;
  quotaPolicySource: QuotaPolicySource;
  quotaPolicyVersion: number | null;
};

// ---- 可配置月度配额策略（migrations/020_credit_quota_policy.sql）----

/** 策略范围：global 是默认值，user 是单用户覆盖或显式恢复继承。 */
export const quotaPolicyScopes = ['global', 'user'] as const;
export type QuotaPolicyScope = (typeof quotaPolicyScopes)[number];

/** `inherit` 只允许出现在用户范围；全局策略必须是 `override`。 */
export const quotaPolicyModes = ['inherit', 'override'] as const;
export type QuotaPolicyMode = (typeof quotaPolicyModes)[number];
export const quotaPolicyModeLabels: Record<QuotaPolicyMode, string> = {
  inherit: '继承全局默认',
  override: '覆盖金额',
};

/** 月度标准与单次调整的上限；共享契约校验，前端表单与服务端都读这一处。 */
export const maxMonthlyQuotaCredits = 1_000_000;
export const maxQuotaAdjustmentCredits = 1_000_000;

/** 策略版本的一行；只追加，不改旧行。 */
export type QuotaPolicyView = {
  id: string;
  scope: QuotaPolicyScope;
  userId: string | null;
  effectivePeriod: string;
  mode: QuotaPolicyMode;
  credits: number | null;
  revision: number;
  note: string | null;
  createdBy: string | null;
  createTime: string;
};

/** 某一账期解析后的有效规则；没有保存过策略时是代码兜底 500。 */
export type EffectiveQuotaPolicy = {
  credits: number;
  source: QuotaPolicySource;
  version: number | null;
  policyId: string | null;
  effectivePeriod: string | null;
};

/** `GET admin/billing/quota/policy`：当前/下一账期的全局规则，可附带单个用户的覆盖。 */
export type QuotaPolicyRange = {
  current: EffectiveQuotaPolicy;
  next: EffectiveQuotaPolicy;
  versions: QuotaPolicyView[];
};
export type QuotaPolicyAdminView = {
  period: string;
  nextPeriod: string;
  defaultCredits: number;
  limits: { maxMonthlyQuotaCredits: number; maxQuotaAdjustmentCredits: number };
  global: QuotaPolicyRange;
  user: (QuotaPolicyRange & { userId: string; userAccount: string; userName: string | null }) | null;
};

const quotaPeriod = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, '账期必须形如 2026-12');

/** 保存策略：expectedRevision 为 null 表示新建；带值表示替换该账期当前版本。 */
export const quotaPolicySaveSchema = z
  .object({
    scope: z.enum(quotaPolicyScopes),
    userId: idSchema.optional(),
    effectivePeriod: quotaPeriod,
    mode: z.enum(quotaPolicyModes),
    credits: z.number().int('配额必须是整数 Credit').min(0, '配额不能是负数').max(maxMonthlyQuotaCredits, `单月配额不能超过 ${maxMonthlyQuotaCredits}`).nullish(),
    expectedRevision: z.number().int().min(1).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'global' && (value.userId !== undefined || value.mode !== 'override')) {
      ctx.addIssue({ code: 'custom', message: '全局策略必须是 override，且不能带 userId' });
    }
    if (value.scope === 'user' && value.userId === undefined) {
      ctx.addIssue({ code: 'custom', message: '用户策略必须指定 userId' });
    }
    if (value.mode === 'override' && (value.credits === null || value.credits === undefined)) {
      ctx.addIssue({ code: 'custom', message: '覆盖策略必须填写金额' });
    }
    if (value.mode === 'inherit' && value.credits !== null && value.credits !== undefined) {
      ctx.addIssue({ code: 'custom', message: '继承策略不能带金额' });
    }
  });
export type QuotaPolicySaveRequest = z.infer<typeof quotaPolicySaveSchema>;

export type QuotaPolicySaveReceipt = {
  policy: QuotaPolicyView;
  /** 保存后按目标账期重新解析的结果，便于界面立即核对。 */
  effective: EffectiveQuotaPolicy;
};

/** 每用户每账期一条基础发放事实；零配额也记一行。 */
export type QuotaIssueView = {
  id: string;
  userId: string;
  period: string;
  baseCredits: number;
  status: 'granted' | 'failed';
  policySource: QuotaPolicySource;
  policyVersion: number | null;
  policyId: string | null;
  grantId: string | null;
  reason: string | null;
  createTime: string;
  updateTime: string;
};
// ---- Credit Charge（migrations/012_credit_charge_entry.sql）----

/**
 * Charge 的状态：`settled` 全部真实计价、`estimated` 含估算步骤、`partial` 部分步骤待处理、
 * `unpriced` 一步都算不出钱、`reversed` 全部原始分录已被反向分录覆盖（90 的冲正）。
 */
export const chargeStatuses = ['settled', 'estimated', 'partial', 'unpriced', 'reversed'] as const;
export type ChargeStatus = typeof chargeStatuses[number];
export const chargeStatusLabels: Record<ChargeStatus, string> = {
  settled: '已结算',
  estimated: '估算',
  partial: '部分待处理',
  unpriced: '待处理',
  reversed: '已退还',
};

/** Tag 颜色只影响可读性，文案仍来自 `chargeStatusLabels`；两个账单列表共用这一份。 */
export const chargeStatusColors: Record<ChargeStatus, string> = {
  settled: 'green',
  estimated: 'orange',
  partial: 'gold',
  unpriced: 'default',
  reversed: 'blue',
};

/**
 * Charge 的逐步骤用量快照（`usage_snapshot` 的一行）：上报值原样保留，
 * `billed*` 是本步实际参与计价的 token（估算时与上报值不同），`sampleSteps` 是估算依据的样本数。
 * 估算绝不写回 `input`/`output`：账单要能区分「上游说用了多少」与「我们按均值推了多少」。
 */
export type UsageSnapshotStep = {
  /** `generation_step.id` 的字符串形式：补结算按它判断「这一步是否已经进过账」（93）。 */
  stepId: string | null;
  providerId: string | null;
  modelName: string | null;
  upstreamModelId: string | null;
  at: string;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  billedInput: number | null;
  billedCacheRead: number | null;
  billedOutput: number | null;
  estimated: boolean;
  sampleSteps: number;
  priced: boolean;
  rate: RateCardVersionKey | null;
};

/** 一笔 Charge 的原始扣减分录（按池拆分）：正数为扣减金额。 */
export type ChargeEntryView = { pool: CreditPool; credits: number };

/**
 * 一条冲正分录：按原分录的池同额退回，`credits` 为负数（退了多少），`reason` 说明退还原因
 * ——自动冲正固定写 `platformReversalReason`，人工冲正写管理员填的原因（92）。
 */
export type ChargeReversalView = { pool: CreditPool; credits: number; reason: string | null; createTime: string };

/**
 * 平台自身故障导致的终止：先按实收结算，再自动整笔冲正，用户实际不承担费用
 * （`docs/adr/0004-credit-billing.md`「Outcome decides reversibility, not amount」）。
 * 其余终态一律按实收——`interrupted` 也是：进程崩溃时 token 确实烧掉了。
 */
export const platformFaultStopReasons = ['initialization-failed', 'lease-lost'] as const satisfies readonly GenerationStopReason[];

/** 归责判定的唯一实现处：服务端结算与界面文案都读它，不各自再写一份停止原因列表。 */
export function isPlatformFault(stopReason: GenerationStopReason | null): boolean {
  return stopReason !== null && (platformFaultStopReasons as readonly string[]).includes(stopReason);
}

/** 自动冲正写进 `credit_entry.reason` 的固定文案：界面与对账据此区分自动退还与人工冲正。 */
export const platformReversalReason = '平台故障自动退还';

/**
 * `GET billing/charges` 的一行：用户账单上那一条。
 * `messageId` 是挂到助手气泡的唯一关联键；`credits` 是投影，`effectiveCredits` 是分录净额（冲正后变小）。
 * `costUsd` 只对管理员返回：普通用户看售价，不看平台成本。
 */
export type BillingChargeView = {
  generationId: string;
  messageId: string | null;
  appId: string;
  /** 账单所属 App 的名称，App 被删或没命名时为 null：界面只回退显示 appId，不隐藏这笔账。 */
  appName: string | null;
  credits: number;
  effectiveCredits: number;
  costUsd?: string | null;
  status: ChargeStatus;
  estimatedSteps: number;
  /**
   * 账单质量：`estimated` = 有步骤按样本均值估算、`unpriced` = 有步骤没有任何费率可用。
   * 两者都由 `usage_snapshot` 投影得到，所以冲正把 status 改写成 `reversed` 之后仍然可读——
   * 管理界面据此判断「这笔售价里有多少是猜的」，Owner 界面据此标记「估算 / 未定价」。
   */
  estimated: boolean;
  unpriced: boolean;
  createTime: string;
  generationStatus: GenerationStatus | null;
  stopReason: GenerationStopReason | null;
  /** 原始扣减分录（按池）；冲正后仍然保留，账单才能说清「原来扣了多少」。 */
  entries: ChargeEntryView[];
  /** 冲正分录；没被冲正时是空数组。退款去向（哪个池、退了多少）只能从这里读。 */
  reversals: ChargeReversalView[];
};

// ---- Admin 用量与手工冲正（92）----

/** `POST admin/billing/charge/:id/reverse` 的请求体：理由必填，写进反向分录的 `reason` 与操作人。 */
export const chargeReversalRequestSchema = z.object({
  reason: z.string().trim().min(1, '请填写冲正理由').max(500, '冲正理由最多 500 字'),
});
export type ChargeReversalRequest = z.infer<typeof chargeReversalRequestSchema>;

/**
 * 冲正回执：`reversed=false` 表示这笔账单此前已经整笔冲正过，本次没有追加分录、没有重复退款。
 * `effectiveCredits` 是冲正后由分录重算出的净额（整笔冲正后为 0）。
 */
export type ChargeReversalReceipt = {
  reversed: boolean;
  entries: number;
  status: ChargeStatus;
  effectiveCredits: number;
};

/**
 * `GET admin/billing/usage?userId=`：一个用户的额度快照 + 最近账单 + 质量比例。
 * 两个比例都按**账单条数**计（0..1，保留 4 位小数），描述「最近这些账单里有多少条含估算/未定价步骤」，
 * 不按 Credit 加权：估算步的实际偏差不可知，加权会把它展示成精确数字。
 */
export type AdminUserUsage = {
  userId: string;
  account: AccountSnapshot;
  /** 身份、配额拆解、快照核对与流水；92 的旧字段保留，界面逐步迁到这一份。 */
  credit: AdminUserCreditDetail;
  charges: BillingChargeView[];
  estimatedRatio: number;
  unpricedRatio: number;
};

// ---- 补结算与余额核对（issue #93，src/server/billing/settlement.ts）----

/**
 * 一次对账扫描里单项的处理结果：`settled` 新建账单并完成扣款、`retried` 给已有账单补记差额、
 * `skipped` 没有可做的事（已结算、仍缺费率、已退还、生成已删除）、`failed` 处理时抛错。
 */
export const reconcileOutcomes = ['settled', 'retried', 'skipped', 'failed'] as const;
export type ReconcileOutcome = (typeof reconcileOutcomes)[number];
export const reconcileOutcomeLabels: Record<ReconcileOutcome, string> = {
  settled: '已结算',
  retried: '已补记',
  skipped: '仍待处理',
  failed: '失败',
};

/** `reconcileSettlements` 的逐项结果；`reason` 是给人看的处理依据或待处理原因。 */
export type ReconcileItem = { generationId: string; outcome: ReconcileOutcome; reason?: string };

/** `reconcileSettlements` 的汇总：`settled`/`skipped` 只数新建与未变动的条目，补记与失败看 `results`。 */
export type ReconcileRun = { scanned: number; settled: number; skipped: number; results: ReconcileItem[] };

/** `POST admin/billing/reconcile` 的请求体：默认全库扫 50 条；`generationId` 用于后台单条重试。 */
export const reconcileRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  generationId: z.string().trim().min(1).max(36).optional(),
});
export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;

/** 后台「待处理」列表的一行：终态缺账的 Generation，或已有账单但还有步骤没进账。 */
export type PendingSettlementItem = {
  generationId: string;
  appId: string | null;
  userId: string | null;
  generationStatus: GenerationStatus | null;
  stopReason: GenerationStopReason | null;
  chargeStatus: ChargeStatus | null;
  credits: number | null;
  /** 快照里还没有身份的模型步骤数；终态缺账时整张账单都没写，记 0。 */
  missingSteps: number;
  reason: string;
};

export type PendingSettlementList = { items: PendingSettlementItem[] };

/** 余额核对结果：`diff = actual - expected`。只报告，不改账本事实；修复见 `rebuildAccount`。 */
export type AccountAudit = {
  expected: { quota: number; balance: number };
  actual: { quota: number; balance: number };
  diff: { quota: number; balance: number };
};

// ---- 准入（票 94；不需要迁移）----

/**
 * Credit 不足的唯一错误码：`BusinessError(402, insufficientCreditsCode, …)`。
 * 界面按它识别（不复用 40900 / 40300），服务端只有准入这一处会抛出。
 */
export const insufficientCreditsCode = 40201;

/**
 * Credit 不足的完整文案：说清当前可用 Credit 与下一步。服务端（402 的 message）与界面（首页预检）
 * 共用这一处措辞，界面不再自己拼一遍数字。
 *
 * 支付通道尚未开通，所以唯一可执行的下一步是「联系管理员补充 Credit」——不给充值/购买入口，
 * 那是兑现不了的按钮。
 */
export function insufficientCreditsMessage(available: { quota: number; balance: number; total: number }): string {
  return `当前可用 Credit 为 ${available.total}（${poolLabels.quota} ${available.quota} + ${poolLabels.balance} ${available.balance}），`
    + '不足以开始新的生成。请联系管理员补充 Credit 后再提交。';
}

// ---- Admin 全用户额度总览（admin-credit-quota C1）----

/** 总览筛选：待发、欠款、零可用；`all` 不额外过滤。 */
export const adminCreditFilters = ['all', 'pending', 'debt', 'zero'] as const;
export type AdminCreditFilter = (typeof adminCreditFilters)[number];
export const adminCreditFilterLabels: Record<AdminCreditFilter, string> = {
  all: '全部用户',
  pending: '配额待发',
  debt: '余额欠款',
  zero: '零可用',
};

/** 列表排序；金额字段是「合计可用」与「余额池」。 */
export const adminCreditSorts = ['id_desc', 'total_desc', 'total_asc', 'balance_desc', 'balance_asc'] as const;
export type AdminCreditSort = (typeof adminCreditSorts)[number];
export const adminCreditSortLabels: Record<AdminCreditSort, string> = {
  id_desc: '用户 ID（新到旧）',
  total_desc: '合计可用（高到低）',
  total_asc: '合计可用（低到高）',
  balance_desc: '余额池（高到低）',
  balance_asc: '余额池（低到高）',
};

export const adminCreditOverviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(256).optional(),
  filter: z.enum(adminCreditFilters).default('all'),
  sort: z.enum(adminCreditSorts).default('id_desc'),
});
export type AdminCreditOverviewQuery = z.infer<typeof adminCreditOverviewQuerySchema>;

/** 管理面识别一个用户的三个字段；用户名为空时界面必须给占位，不能显示成空白。 */
export type AdminCreditUser = { userId: string; userAccount: string; userName: string | null };

/** 当前账期的发放状态：没有记录或失败是待发，零配额发放成功也算已发。 */
export const adminQuotaStatuses = ['pending', 'granted', 'failed'] as const;
export type AdminQuotaStatus = (typeof adminQuotaStatuses)[number];
export const adminQuotaStatusLabels: Record<AdminQuotaStatus, string> = {
  pending: '待发',
  granted: '已发',
  failed: '发放失败',
};

/** 配额的来源：全局默认、用户覆盖、迁移前旧 grant、代码兜底。 */
export const quotaPolicySources = ['global', 'user', 'legacy', 'fallback'] as const;
export type QuotaPolicySource = (typeof quotaPolicySources)[number];
export const quotaPolicySourceLabels: Record<QuotaPolicySource, string> = {
  global: '全局默认',
  user: '用户覆盖',
  legacy: '历史发放',
  fallback: '系统默认',
};

/** 总览一行：金额全部由服务端按账期事实算出，界面不重算。 */
export type AdminCreditOverviewItem = AdminCreditUser & {
  period: string;
  quotaBase: number;
  quotaAdjustments: number;
  quotaUsed: number;
  quotaRemaining: number;
  balance: number;
  total: number;
  debt: number;
  issueStatus: AdminQuotaStatus;
  policySource: QuotaPolicySource;
  policyVersion: number | null;
  expiresAt: string;
  /** 已发状态下快照与账本事实不一致；未发用户的旧快照不视为异常。 */
  snapshotAnomaly: boolean;
};

/** 总览统计只覆盖当前筛选范围，不是当前页。 */
export type AdminCreditOverviewStats = {
  userCount: number;
  pendingCount: number;
  quotaRemainingTotal: number;
  balanceNetTotal: number;
  debtorCount: number;
  debtTotal: number;
};

export type AdminCreditOverview = {
  period: string;
  asOf: string;
  page: number;
  pageSize: number;
  total: number;
  items: AdminCreditOverviewItem[];
  stats: AdminCreditOverviewStats;
};

/** 用户搜索下拉的候选：服务端按账号/用户名 OR 匹配，完整 ID 精确命中。 */
export type AdminUserSearchResult = { users: AdminCreditUser[] };

/** 当前账期的配额拆解。`remainingCredits = max(0, base + adjustments - used)`。 */
export type AdminQuotaDetail = {
  period: string;
  baseCredits: number;
  adjustmentCredits: number;
  usedCredits: number;
  remainingCredits: number;
  issueStatus: AdminQuotaStatus;
  policySource: QuotaPolicySource;
  policyVersion: number | null;
  expiresAt: string;
};

/** 用户详情：身份、两池事实、快照核对与最近流水。 */
export type AdminUserCreditDetail = {
  user: AdminCreditUser;
  period: string;
  quota: AdminQuotaDetail;
  balance: number;
  purchasedCredits: number;
  purchasedCredits60d: number;
  adminGrantedCredits: number;
  total: number;
  debt: number;
  overdraft: number;
  snapshot: { quota: number; balance: number; updateTime: string | null };
  snapshotAnomaly: boolean;
  grants: CreditGrantView[];
  /** 当前/下一账期的有效规则；用户覆盖会改变 source 与金额。 */
  rule: { current: EffectiveQuotaPolicy; next: EffectiveQuotaPolicy };
  /** 最近的基础发放事实，含 0 配额；与 grant 流水分开。 */
  issues: QuotaIssueView[];
  asOf: string;
};
