import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDatabaseUrl } from '../../support/test-database-url';
import { eq } from 'drizzle-orm';
import { POST } from '@/app/api/[...path]/route';
import { db, getPool } from '@/server/infra/db';
import { appConfig, sessions, users } from '@/server/infra/schema';
import type {
  ModelProviderOptions,
  ModelProviderWriteInput,
  ProviderApiFormat,
  ProviderKeySource,
} from '@/shared/model-config';
import type { ModelConfigMutation } from '@/shared/model-document';
import * as modelStore from '@/server/models/store';
import { initializeModelConfigFromEnv } from '@/server/models/store';
import { resetModelConfigRow } from '../../support/model-config';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

const prefix = `ts_model_admin_${Date.now()}`;
const secretValue = 'sk-model-admin-must-not-leak';
let adminCookie = '';
let memberCookie = '';
let adminId = '';
let memberId = '';

const savedEnvironment = new Map(
  [
    'AI_MODEL',
    'AI_BASE_URL',
    'AI_API_KEY',
    'MODEL_API_KEY_ENV_ALLOWLIST',
    'MODEL_INTERNAL_BASE_URL_ORIGINS',
    'MODEL_SECRET_KEY',
  ].map((name) => [name, process.env[name]]),
);

async function request(path: string, data: unknown, session?: string): Promise<Response> {
  const headers: Record<string, string> = {
    origin: 'http://localhost:3000',
    'content-type': 'application/json',
  };
  if (session) headers.cookie = session;
  const req = new Request(`http://localhost:3000/api/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  return POST(req, { params: Promise.resolve({ path: path.split('/') }) });
}

async function json(response: Response) {
  return response.json() as Promise<{ code: number; data: unknown; message: string }>;
}

async function createUser(account: string) {
  const credentials = {
    userAccount: account,
    userPassword: 'password123',
    checkPassword: 'password123',
  };
  const id = (await json(await request('user/register', credentials))).data as string;
  const login = await request('user/login', credentials);
  return { id, cookie: login.headers.get('set-cookie')!.split(';')[0] };
}

type ProviderDraft = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKey: string;
  options: ModelProviderOptions;
  enabled: boolean;
};

function providerInput(overrides: Partial<ProviderDraft> = {}): ModelProviderWriteInput {
  const draft: ProviderDraft = {
    id: 'env-default',
    displayName: '环境默认提供商',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.example.test/v1',
    apiKeySource: 'env',
    apiKeyEnv: 'AI_API_KEY',
    apiKey: 'sk-inline-test',
    options: {},
    enabled: true,
    ...overrides,
  };
  const common = {
    id: draft.id,
    displayName: draft.displayName,
    apiFormat: draft.apiFormat,
    baseUrl: draft.baseUrl,
    options: draft.options,
    enabled: draft.enabled,
  };
  return draft.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: draft.apiKey };
}

async function config() {
  const response = await request('model/admin/config', {}, adminCookie);
  const payload = await json(response);
  if (payload.code !== 0) throw new Error(payload.message);
  return payload.data as {
    revision: string;
    refreshEpoch: string;
    initialized: boolean;
    documentBytes: number;
    providers: {
      id: string;
      displayName: string;
      apiKeySource: string;
      apiKeyEnv?: string;
      apiKeyConfigured: boolean;
      models: {
        id: string;
        upstream: string;
        displayName: string;
        enabled: boolean;
        prices: unknown[];
        currentPrice: unknown;
      }[];
    }[];
    assignments: { slot: string; modelId: string }[];
    slotDefinitions: { slot: string; optional: boolean; label: string; requires: string[] }[];
    providerFormats: { value: string; optionKeys: string[] }[];
    allowedApiKeyEnvs: string[];
    instance: { degraded: boolean };
  };
}

async function mutate(mutation: ModelConfigMutation, revision: string, applyImmediately = false) {
  return request(
    'model/admin/config/mutate',
    { expectedRevision: revision, mutation, applyImmediately },
    adminCookie,
  );
}

async function modelId(providerId = 'env-default', upstream = 'gpt-test-model'): Promise<string> {
  const data = await config();
  const model = data.providers
    .find((provider) => provider.id === providerId)
    ?.models.find((candidate) => candidate.upstream === upstream);
  if (!model) throw new Error(`模型 ${providerId}/${upstream} 不存在`);
  return model.id;
}

describe('模型管理 API（JSON 文档）', () => {
  beforeAll(async () => {
    process.env.AI_MODEL = 'gpt-test-model';
    process.env.AI_BASE_URL = 'https://api.example.test/v1';
    process.env.AI_API_KEY = secretValue;
    process.env.MODEL_SECRET_KEY = 'b'.repeat(64);
    delete process.env.MODEL_API_KEY_ENV_ALLOWLIST;
    delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    const admin = await createUser(prefix);
    adminId = admin.id;
    adminCookie = admin.cookie;
    const member = await createUser(`${prefix}_member`);
    memberId = member.id;
    memberCookie = member.cookie;
    await db()
      .update(users)
      .set({ userRole: 'admin' })
      .where(eq(users.id, BigInt(adminId)));
  });

  beforeEach(async () => {
    await resetModelConfigRow();
    await initializeModelConfigFromEnv();
  });

  afterAll(async () => {
    await resetModelConfigRow();
    for (const id of [adminId, memberId]) {
      if (!id) continue;
      await db()
        .delete(sessions)
        .where(eq(sessions.userId, BigInt(id)));
      await db()
        .delete(users)
        .where(eq(users.id, BigInt(id)));
    }
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await getPool().end();
  });

  it('未登录与普通用户都被拒绝', async () => {
    expect((await request('model/admin/config', {})).status).toBe(401);
    expect((await request('model/admin/config', {}, memberCookie)).status).toBe(403);
    const memberMutation = await request(
      'model/admin/config/mutate',
      { expectedRevision: '1', mutation: { kind: 'provider.delete', providerId: 'env-default' } },
      memberCookie,
    );
    expect(memberMutation.status).toBe(403);
    const anonymous = new Request('http://localhost:3000/api/model/admin/config/mutate', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: '1',
        mutation: { kind: 'provider.delete', providerId: 'env-default' },
      }),
    });
    expect(
      (
        await POST(anonymous, {
          params: Promise.resolve({ path: ['model', 'admin', 'config', 'mutate'] }),
        })
      ).status,
    ).toBe(401);
  });

  it('写请求必须来自管理界面来源', async () => {
    const wrong = new Request('http://localhost:3000/api/model/admin/config/mutate', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3001',
        cookie: adminCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: '1',
        mutation: { kind: 'provider.delete', providerId: 'env-default' },
      }),
    });
    expect(
      (
        await POST(wrong, {
          params: Promise.resolve({ path: ['model', 'admin', 'config', 'mutate'] }),
        })
      ).status,
    ).toBe(403);
  });

  it('管理员读取配置返回提供商、嵌套模型、槽位、UI 名单与密钥状态，且不含明文密钥', async () => {
    const response = await request('model/admin/config', {}, adminCookie);
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.code).toBe(0);
    const data = payload.data as Awaited<ReturnType<typeof config>>;
    expect(data).toMatchObject({ revision: '1', refreshEpoch: '0', initialized: true });
    expect(data.documentBytes).toBeGreaterThan(0);
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({
      id: 'env-default',
      apiKeyEnv: 'AI_API_KEY',
      apiKeyConfigured: true,
    });
    expect(data.providers[0]?.models).toHaveLength(1);
    expect(data.providers[0]?.models[0]).toMatchObject({
      upstream: 'gpt-test-model',
      prices: [],
      currentPrice: null,
    });
    expect(data.assignments.map((slot) => slot.slot).sort()).toEqual([
      'codegen.default',
      'route.classify',
    ]);
    expect(data.slotDefinitions.map((slot) => slot.slot)).toEqual([
      'codegen.default',
      'route.classify',
      'version.summary',
      'speech.transcribe',
    ]);
    expect(data.slotDefinitions[0]).toMatchObject({
      label: '代码生成',
      requires: ['streaming', 'toolCalling'],
      optional: false,
    });
    expect(data.providerFormats.map((format) => format.value)).toEqual([
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
    ]);
    expect(data.providerFormats[0]?.optionKeys).toEqual([
      'includeUsage',
      'supportsStructuredOutputs',
      'supportsMultiPartToolContent',
      'thinkingSwitch',
    ]);
    expect(data.allowedApiKeyEnvs).toEqual(['AI_API_KEY']);
    expect(typeof data.instance.degraded).toBe('boolean');
    expect(JSON.stringify(data)).not.toContain(secretValue);
  });

  it('直接输入的密钥只以密文入库，响应与视图都不回显', async () => {
    const response = await mutate(
      {
        kind: 'provider.upsert',
        provider: providerInput({
          id: 'inline-provider',
          apiKeySource: 'inline',
          apiKey: secretValue,
        }),
      },
      '1',
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secretValue);

    const [row] = await db().select().from(appConfig).where(eq(appConfig.key, 'model_config'));
    expect(JSON.stringify(row?.value)).not.toContain(secretValue);
    const value = row?.value as { providers: { id: string; apiKey: unknown }[] };
    expect(
      value.providers.find((provider) => provider.id === 'inline-provider')?.apiKey,
    ).toMatchObject({ source: 'inline' });

    const data = await config();
    const inline = data.providers.find((candidate) => candidate.id === 'inline-provider');
    expect(inline).toMatchObject({ apiKeySource: 'inline', apiKeyConfigured: true });
    expect(JSON.stringify(data)).not.toContain(secretValue);

    const kept = await mutate(
      {
        kind: 'provider.upsert',
        provider: providerInput({ id: 'inline-provider', apiKeySource: 'inline', apiKey: '' }),
      },
      '2',
    );
    expect(kept.status).toBe(200);
  });

  it('切换 API 格式时不支持的选项返回 400，支持的格式正常保存', async () => {
    const rejected = await mutate(
      {
        kind: 'provider.upsert',
        provider: providerInput({ apiFormat: 'openai-responses', options: { includeUsage: true } }),
      },
      '1',
    );
    expect(rejected.status).toBe(400);
    expect((await json(rejected)).code).toBe(40000);
    const accepted = await mutate(
      { kind: 'provider.upsert', provider: providerInput({ apiFormat: 'openai-responses' }) },
      '1',
    );
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).data).toMatchObject({ revision: '2' });
  });

  it('新增提供商为空分组；新增模型未定价；追加价格后可分配槽位', async () => {
    const created = await mutate(
      {
        kind: 'provider.upsert',
        provider: providerInput({ id: 'secondary', displayName: '备用' }),
      },
      '1',
    );
    expect((await json(created)).data).toMatchObject({ revision: '2' });
    let data = await config();
    expect(data.providers.find((provider) => provider.id === 'secondary')?.models).toEqual([]);

    const modelCreated = await mutate(
      {
        kind: 'model.upsert',
        providerId: 'secondary',
        upstream: 'gpt-extra',
        displayName: '备用模型',
        capabilities: {
          streaming: false,
          toolCalling: false,
          structuredOutput: false,
          imageInput: false,
        },
        enabled: true,
        upstreamPrice: null,
      },
      '2',
    );
    expect((await json(modelCreated)).data).toMatchObject({ revision: '3' });
    data = await config();
    expect(data.providers.find((provider) => provider.id === 'secondary')?.models).toHaveLength(1);
    const id = await modelId('secondary', 'gpt-extra');

    const tooEarly = await mutate(
      { kind: 'slot.assign', slot: 'version.summary', modelId: id, settings: {} },
      '3',
    );
    expect(tooEarly.status).toBe(400);
    expect((await json(tooEarly)).message).toContain('还没有当前生效的单价');

    const priced = await mutate(
      {
        kind: 'model.price',
        modelId: id,
        inputMissFen: 120,
        inputHitFen: 12,
        outputFen: 480,
        upstreamUsd: null,
        note: null,
      },
      '3',
    );
    expect((await json(priced)).data).toMatchObject({ revision: '4' });
    const assigned = await mutate(
      { kind: 'slot.assign', slot: 'version.summary', modelId: id, settings: { temperature: 0.3 } },
      '4',
    );
    expect((await json(assigned)).data).toMatchObject({ revision: '5' });
    data = await config();
    expect(
      data.providers.find((provider) => provider.id === 'secondary')?.models[0]?.currentPrice,
    ).toMatchObject({ inputMissFen: 120 });
    expect(data.assignments.find((slot) => slot.slot === 'version.summary')?.modelId).toBe(id);

    const cleared = await mutate({ kind: 'slot.clear', slot: 'version.summary' }, '5');
    expect(cleared.status).toBe(200);
    expect((await config()).assignments.some((slot) => slot.slot === 'version.summary')).toBe(
      false,
    );
  });

  it('清单外槽位与不存在模型被拒绝，必需槽位不能清除', async () => {
    const id = await modelId();
    const unknown = await mutate(
      { kind: 'slot.assign', slot: 'extra.model', modelId: id, settings: {} },
      '1',
    );
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).code).toBe(40000);
    const missing = await mutate(
      { kind: 'slot.assign', slot: 'route.classify', modelId: 'pm_missing', settings: {} },
      '1',
    );
    expect(missing.status).toBe(404);
    const required = await mutate({ kind: 'slot.clear', slot: 'codegen.default' }, '1');
    expect(required.status).toBe(409);
    expect((await json(required)).code).toBe(40902);
    expect((await config()).assignments.map((slot) => slot.slot).sort()).toEqual([
      'codegen.default',
      'route.classify',
    ]);
  });

  it('版本冲突返回 409 并且不写入配置', async () => {
    const stale = await mutate(
      { kind: 'provider.upsert', provider: providerInput({ displayName: '过期写入' }) },
      '0',
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe(40901);
    expect((await config()).providers[0]?.displayName).toBe('环境默认提供商');
  });

  it('停用被引用模型、删除有模型的提供商、清除必需槽位都返回 409', async () => {
    const id = await modelId();
    const disable = await mutate({ kind: 'model.enabled', modelId: id, enabled: false }, '1');
    expect(disable.status).toBe(409);
    expect((await json(disable)).message).toContain('codegen.default');
    const providerDelete = await mutate(
      { kind: 'provider.delete', providerId: 'env-default' },
      '1',
    );
    expect(providerDelete.status).toBe(409);
    expect((await json(providerDelete)).code).toBe(40902);
    expect((await json(await request('model/admin/config', {}, adminCookie))).data).toMatchObject({
      revision: '1',
    });
  });

  it('applyImmediately 与手动 apply 递增刷新序号', async () => {
    const immediate = await mutate(
      { kind: 'provider.upsert', provider: providerInput({ displayName: '立即生效' }) },
      '1',
      true,
    );
    expect((await json(immediate)).data).toMatchObject({ revision: '2', refreshEpoch: '1' });
    const applied = await request('model/admin/apply', { expectedRevision: '2' }, adminCookie);
    expect((await json(applied)).data).toMatchObject({ revision: '2', refreshEpoch: '2' });
    expect(await config()).toMatchObject({ revision: '2', refreshEpoch: '2' });
  });

  it('严格 payload 拒绝未知字段与非法版本号', async () => {
    expect((await request('model/admin/config', { extra: true }, adminCookie)).status).toBe(400);
    const extra = await request(
      'model/admin/config/mutate',
      {
        expectedRevision: '1',
        mutation: { kind: 'provider.delete', providerId: 'env-default', extra: 1 },
      },
      adminCookie,
    );
    expect(extra.status).toBe(400);
    const badVersion = await request('model/admin/apply', { expectedRevision: '01' }, adminCookie);
    expect(badVersion.status).toBe(400);
  });

  it('app_config 行缺失时返回脱敏 503', async () => {
    await db().delete(appConfig).where(eq(appConfig.key, 'model_config'));
    const response = await request('model/admin/config', {}, adminCookie);
    expect(response.status).toBe(503);
    const payload = await json(response);
    expect(payload.code).toBe(50300);
    expect(JSON.stringify(payload)).not.toContain(secretValue);
  });

  it('空配置读取返回 initialized:false、版本 0、空列表，且不会自动初始化', async () => {
    await resetModelConfigRow();
    const data = await config();
    expect(data).toMatchObject({ revision: '0', refreshEpoch: '0', initialized: false });
    expect(data.providers).toEqual([]);
    expect(data.assignments).toEqual([]);
    expect((await request('model/admin/config', {}, adminCookie)).status).toBe(200);
  });

  it('存储层未预期错误被脱敏为 503，日志不含敏感内容', async () => {
    const sentinel = 'sk-sentinel-secret-value';
    const noisy = new Error(
      `connect failed mysql://user:${sentinel}@db:3306/app; SELECT value FROM app_config WHERE value='${sentinel}'`,
    );
    const readSpy = vi
      .spyOn(modelStore, 'readModelConfigDocumentState')
      .mockRejectedValueOnce(noisy);
    const logged: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const response = await request('model/admin/config', {}, adminCookie);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 50300 });
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('mysql://');
      expect(logged.join(' ')).not.toContain(sentinel);
      expect(logged.join(' ')).toContain('Error');
    } finally {
      errors.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('写路径的存储层未预期错误同样脱敏为 503', async () => {
    const sentinel = 'sk-write-sentinel';
    const writeSpy = vi
      .spyOn(modelStore, 'mutateModelConfig')
      .mockRejectedValueOnce(new Error(`write failed ${sentinel}`));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await mutate(
        { kind: 'provider.upsert', provider: providerInput({ displayName: '未预期失败' }) },
        '1',
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 50300 });
      expect(text).not.toContain(sentinel);
    } finally {
      errors.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('成功与失败路径的响应和日志都不出现密钥值', async () => {
    const logged: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const warns = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      expect(await (await request('model/admin/config', {}, adminCookie)).text()).not.toContain(
        secretValue,
      );
      const conflict = await request('model/admin/apply', { expectedRevision: '9' }, adminCookie);
      expect(await conflict.text()).not.toContain(secretValue);
      expect(logged.join(' ')).not.toContain(secretValue);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('提供商连通性检测：鉴权、地址、密钥与上游失败都被归一化', async () => {
    const anonymous = await request('model/admin/provider/models', { provider: providerInput() });
    expect(anonymous.status).toBe(401);
    expect(
      (await request('model/admin/provider/models', { provider: providerInput() }, memberCookie))
        .status,
    ).toBe(403);
    const blockedAddress = await request(
      'model/admin/provider/models',
      { provider: providerInput({ baseUrl: 'http://api.example.com/v1' }) },
      adminCookie,
    );
    expect(blockedAddress.status).toBe(400);
    expect((await json(blockedAddress)).code).toBe(40000);
    const blockedEnv = await request(
      'model/admin/provider/models',
      { provider: providerInput({ apiKeyEnv: 'OTHER_KEY' }) },
      adminCookie,
    );
    expect(blockedEnv.status).toBe(400);
    expect((await json(blockedEnv)).message).toContain('未允许的环境变量 OTHER_KEY');
  });

  it('提供商连通性检测：拉取上游模型列表、复用已保存的密钥并脱敏失败信息', async () => {
    const received: (string | undefined)[] = [];
    let upstreamStatus = 401;
    let upstreamBody: Record<string, unknown> = { error: { message: `bad key ${secretValue}` } };
    const upstream = createServer((request, response) => {
      received.push(request.headers.authorization);
      response.writeHead(upstreamStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(upstreamBody));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const savedOrigins = process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
    process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = upstreamUrl;
    try {
      const rejected = await request(
        'model/admin/provider/models',
        { provider: providerInput({ baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(rejected.status).toBe(502);
      const rejectedText = await rejected.text();
      expect(JSON.parse(rejectedText).message).toBe('上游拒绝了这个密钥，请检查密钥是否有效');
      expect(rejectedText).not.toContain(secretValue);

      upstreamStatus = 200;
      upstreamBody = { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] };
      const listed = await request(
        'model/admin/provider/models',
        { provider: providerInput({ baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(listed.status).toBe(200);
      expect((await json(listed)).data).toEqual({
        models: [
          { id: 'deepseek-flash', label: 'deepseek-flash' },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
        ],
      });
      expect(received.at(-1)).toBe(`Bearer ${secretValue}`);

      const inlineKey = 'sk-inline-probe-secret';
      const upsert = await mutate(
        {
          kind: 'provider.upsert',
          provider: providerInput({
            apiKeySource: 'inline',
            apiKey: inlineKey,
            baseUrl: upstreamUrl,
          }),
        },
        '1',
      );
      expect(upsert.status).toBe(200);
      const reuse = await request(
        'model/admin/provider/models',
        { provider: providerInput({ apiKeySource: 'inline', apiKey: '', baseUrl: upstreamUrl }) },
        adminCookie,
      );
      expect(reuse.status).toBe(200);
      expect(received.at(-1)).toBe(`Bearer ${inlineKey}`);

      const missingKey = await request(
        'model/admin/provider/models',
        {
          provider: providerInput({
            id: 'unknown-provider',
            apiKeySource: 'inline',
            apiKey: '',
            baseUrl: upstreamUrl,
          }),
        },
        adminCookie,
      );
      expect(missingKey.status).toBe(400);
      expect((await json(missingKey)).message).toBe('请填写直接输入的密钥');
    } finally {
      if (savedOrigins === undefined) delete process.env.MODEL_INTERNAL_BASE_URL_ORIGINS;
      else process.env.MODEL_INTERNAL_BASE_URL_ORIGINS = savedOrigins;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
