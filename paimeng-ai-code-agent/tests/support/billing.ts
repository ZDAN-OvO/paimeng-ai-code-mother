import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { testDatabaseUrl } from './test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appConfig, apps, creditBalance, creditLedger, generationSteps, generations, users,
} from '@/server/infra/schema';
import { rebuildBalance } from '@/server/billing/ledger';
import { balanceFactsOf } from '@/server/billing/expiry';
import { naiveTime, periodOf, periodRange } from '@/server/billing/period';
import { requiredModelAliases } from '@/shared/model-config';
import { emptyModelConfigDocument, modelConfigDocumentSchema, modelConfigKey, type ModelConfigDocument } from '@/shared/model-document';
import type { WorkspaceApp } from '@/server/workspace/workspace';

/**
 * 计费集成测试的共享入口：只操作隔离的 `_test` 库，迁移可重复执行。
 * 与 `tests/integration/generation/generation-budget.test.ts` 同一套做法，抽出来避免每个文件复制一份。
 * 它同时被 `tests/integration/billing/` 与 `tests/integration/harness/` 使用，所以按 `tests/AGENTS.md`
 * 的「跨套件 helper 放 `tests/support/`」放在这里。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06', '23505']);
const appOrigin = 'http://localhost:3000';

let loaded = false;

/** 在任何数据库访问之前调用：加载 .env、把 DATABASE_URL 指到 _test 库、把模型配置固定成夹具。 */
export function loadBillingDatabase() {
  if (!loaded) {
    loadEnvFile('.env');
    process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
    process.env.AI_MODE = 'fixture';
    loaded = true;
  }
  return getPool();
}

/** 逐条执行迁移语句；表/列/索引已存在视为成功，让「库比 worktree 新」也能跑。 */
export async function applyBillingMigrations(...names: string[]): Promise<void> {
  const pool = loadBillingDatabase();
  for (const name of names) {
    const text = await readFile(`migrations/${name}`, 'utf8');
    for (const raw of text.split(';')) {
      const statement = raw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
      if (!statement) continue;
      try {
        await pool.query(statement);
      } catch (error) {
        const code = (error as { code?: string }).code ?? '';
        if (!duplicateCodes.has(code)) throw error;
      }
    }
  }
}

export type Envelope<T> = { code: number; data: T; message: string };

/** 直接调用路由处理器，走真实的 guardRequest / 鉴权 / 信封。 */
export async function billingRequest(path: string, data?: unknown, session?: string): Promise<Response> {
  const method = data === undefined ? 'GET' : 'POST';
  const request = new Request(`${appOrigin}/api/${path}`, {
    method,
    headers: {
      origin: appOrigin,
      ...(session ? { cookie: session } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return (method === 'GET' ? GET : POST)(request, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
}

export async function envelopeOf<T = unknown>(response: Response): Promise<Envelope<T>> {
  return await response.json() as Envelope<T>;
}

export type BillingTestUser = { id: string; account: string; cookie: string };

/** 通过注册与登录接口造一个真实用户；管理员靠改库升级角色（角色每次请求重读数据库）。 */
export async function createBillingUser(options: { role?: 'user' | 'admin' } = {}): Promise<BillingTestUser> {
  loadBillingDatabase();
  const account = `billing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const credentials = { userAccount: account, userPassword: 'password123', checkPassword: 'password123' };
  const registered = await envelopeOf<string>(await billingRequest('user/register', credentials));
  if (registered.code !== 0) throw new Error(`注册测试用户失败：${registered.message}`);
  const login = await billingRequest('user/login', credentials);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('测试用户登录未返回会话');
  if (options.role === 'admin') {
    await db().update(users).set({ userRole: 'admin' }).where(eq(users.id, BigInt(registered.data)));
  }
  return { id: registered.data, account, cookie };
}

// ---- 账单夹具 ----
//
// 结算与归责用例只需要「一个 App + 若干终态 Generation + 步骤行 + 费率 + 余额」，
// 这些造数助手放在这里复用，避免每个账单测试文件各抄一份。
// 它们只写数据、不做断言；清理由各文件的 afterAll 负责（费率行除外，见 purgeBillingRateCards）。

export const billingRateProvider = 'billing-fixture';
const seededRateProviders = new Set<string>([billingRateProvider]);
let seededApps = 0;

/** 直接插一个 App（不起工作区/执行）：结算用例不需要真实文件系统。 */
export async function seedBillingApp(ownerUserId: string): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  seededApps += 1;
  await db().insert(apps).values({
    id, appName: `账单测试 ${seededApps}`, initPrompt: 'billing', codeGenType: 'html',
    userId: BigInt(ownerUserId), createTime: now(), updateTime: now(),
  });
  return { id: String(id), codeGenType: 'html' };
}

/** 直接插一条终态 generation：核心结算用例不经过生命周期，只关心账本结果。 */
export async function seedBillingGeneration(input: {
  appId: string; userId: string; status?: string; stopReason?: string | null; messageId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db().insert(generations).values({
    id, appId: BigInt(input.appId), userId: BigInt(input.userId), status: input.status ?? 'ready',
    stopReason: input.stopReason ?? 'completed', messageId: input.messageId ?? null,
    createTime: now(), updateTime: now(),
  });
  return id;
}

/** 步骤行：默认一个正常的模型步骤；token 传 null 表示上游没给用量。 */
export async function seedBillingStep(generationId: string, input: {
  kind?: string; modelName: string; providerId?: string; upstreamModelId?: string | null;
  input?: number | null; cacheRead?: number | null; cacheWrite?: number | null; output?: number | null;
  reasoning?: number | null; round?: number; stepNumber?: number;
}): Promise<void> {
  await db().insert(generationSteps).values({
    generationId,
    kind: input.kind ?? 'model',
    round: input.round ?? 1,
    stepNumber: input.stepNumber ?? 0,
    providerId: input.providerId ?? billingRateProvider,
    modelName: input.modelName,
    upstreamModelId: input.upstreamModelId ?? null,
    inputTokens: input.input === undefined ? 0 : input.input,
    cacheReadTokens: input.cacheRead === undefined ? 0 : input.cacheRead,
    cacheWriteTokens: input.cacheWrite === undefined ? 0 : input.cacheWrite,
    outputTokens: input.output === undefined ? 0 : input.output,
    reasoningTokens: input.reasoning ?? null,
    status: 'ok',
    createTime: now(),
  });
}

const billingDocumentTime = '2020-01-01 00:00:00.000';

async function mutateBillingDocument(mutator: (document: ModelConfigDocument) => void): Promise<void> {
  const [row] = await db().select().from(appConfig).where(eq(appConfig.key, modelConfigKey)).limit(1);
  if (!row) throw new Error('app_config.model_config 缺失，请先执行 023 迁移');
  // 其它套件可能留下损坏/空文档；计费夹具只需要价格树，无法解析时从空文档开始。
  let document: ModelConfigDocument;
  try {
    document = modelConfigDocumentSchema.parse(row.value);
  } catch {
    document = emptyModelConfigDocument();
  }
  mutator(document);
  // 计费夹具只关心价格；模型配置读写仍要求两个必需槽位，补到第一个可用模型上。
  if (document.slots.length === 0) {
    const model = document.providers.flatMap(provider => provider.models)[0];
    if (model) {
      document.slots = requiredModelAliases.map(slot => ({ slot, modelId: model.id, settings: {} }));
    }
  }
  await db().update(appConfig).set({ value: document, revision: row.revision + 1n, updatedAt: now() }).where(eq(appConfig.key, modelConfigKey));
}

/** 费率版本按 modelName 区分用例，避免相互影响；生效时间固定在 2020，早于任何步骤。 */
export async function seedBillingRate(input: {
  modelName: string; providerId?: string; creditInputMiss?: number; creditInputHit?: number; creditOutput?: number;
  usdInputMiss?: string | null; usdInputHit?: string | null; usdOutput?: string | null; effectiveAt?: string;
}): Promise<void> {
  const providerId = input.providerId ?? billingRateProvider;
  seededRateProviders.add(providerId);
  await mutateBillingDocument(document => {
    let provider = document.providers.find(candidate => candidate.id === providerId);
    if (!provider) {
      provider = {
        id: providerId,
        displayName: providerId,
        apiFormat: 'openai-chat',
        baseUrl: 'https://billing.example.test/v1',
        apiKey: { source: 'env', env: 'AI_API_KEY' },
        options: {},
        headers: {},
        enabled: true,
        models: [],
        createTime: billingDocumentTime,
        updateTime: billingDocumentTime,
      };
      document.providers.push(provider);
    }
    let model = provider.models.find(candidate => candidate.upstream === input.modelName);
    if (!model) {
      model = {
        id: `pm_billing${document.providers.length}${provider.models.length}`,
        upstream: input.modelName,
        displayName: input.modelName,
        enabled: true,
        capabilities: { streaming: true, toolCalling: true, structuredOutput: true, imageInput: false },
        upstreamPrice: null,
        prices: [],
        createTime: billingDocumentTime,
        updateTime: billingDocumentTime,
      };
      provider.models.push(model);
    }
    const version = model.prices.reduce((max, price) => Math.max(max, price.version), 0) + 1;
    model.prices.push({
      version,
      effectiveAt: input.effectiveAt ?? billingDocumentTime,
      currency: 'CNY',
      inputMissFen: input.creditInputMiss ?? 600,
      inputHitFen: input.creditInputHit ?? 12,
      outputFen: input.creditOutput ?? 2500,
      upstreamUsd: {
        inputMiss: input.usdInputMiss ?? null,
        inputHit: input.usdInputHit ?? null,
        output: input.usdOutput ?? null,
      },
      note: null,
    });
  });
}

export type BillingBucket = 'limited' | 'lasting';

/** 造余额：`limited` 记在当前账期（月底到期），`lasting` 不过期。 */
export async function grantBillingCredits(userId: string, bucket: BillingBucket, credits: number, at: Date = new Date()): Promise<void> {
  const period = bucket === 'limited' ? periodOf(at) : null;
  await db().insert(creditLedger).values({
    userId: BigInt(userId),
    kind: bucket === 'limited' ? 'quota' : 'grant',
    origin: 'manual',
    credits,
    period,
    expiresAt: period === null ? null : naiveTime(periodRange(period).end),
    reason: 'fixture',
    createTime: now(),
  });
  await rebuildBalance(userId, at);
}

/** 直接写一条历史流水（用于跨账期/窗口用例）；写完按账本重算快照。 */
export async function seedLedgerEntry(input: {
  userId: string;
  kind: 'quota' | 'topup' | 'grant' | 'consume' | 'refund' | 'expire';
  origin: 'rule' | 'manual' | 'payment' | 'charge' | 'expiry' | 'reversal';
  credits: number;
  period?: string | null;
  expiresAt?: string | null;
  chargeId?: string | null;
  reversalOf?: bigint | null;
  reason?: string | null;
  createTime: string;
}): Promise<bigint> {
  const [row] = await db().insert(creditLedger).values({
    userId: BigInt(input.userId),
    kind: input.kind,
    origin: input.origin,
    credits: input.credits,
    period: input.period ?? null,
    expiresAt: input.expiresAt ?? null,
    chargeId: input.chargeId ?? null,
    reversalOf: input.reversalOf ?? null,
    reason: input.reason ?? null,
    createTime: input.createTime,
  }).returning({ id: creditLedger.id });
  return row.id;
}

export async function billingBalancesOf(userId: string): Promise<{ available: number; limited: number; lasting: number }> {
  const facts = await balanceFactsOf(userId);
  return { available: facts.available, limited: facts.limited, lasting: facts.lasting };
}

/**
 * 清空一个用户的账本，让用例从「0 积分」的已知状态出发。
 * 注册时会自动发当期规则积分；需要看分桶扣减的用例先调这里。
 */
export async function withoutMonthlyQuota(owner: BillingTestUser): Promise<BillingTestUser> {
  await db().delete(creditLedger).where(eq(creditLedger.userId, BigInt(owner.id)));
  await db().delete(creditBalance).where(eq(creditBalance.userId, BigInt(owner.id)));
  await rebuildBalance(owner.id);
  return owner;
}

/** 删除本进程插入过的提供商与价格版本：`_test` 库跨文件共享，价格会互相影响。 */
export async function purgeBillingRateCards(): Promise<void> {
  const providers = [...seededRateProviders];
  await mutateBillingDocument(document => {
    document.providers = document.providers.filter(provider => !providers.includes(provider.id));
    document.legacyPrices = document.legacyPrices.filter(price => !providers.includes(price.providerId));
  });
}
