import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { routeStarter, starterForPrompt } from '@/server/generation/model';
import { createModelRegistry, modelRegistry } from '@/server/models/registry';
import { BusinessError } from '@/server/infra/http';
import type { ModelAlias, ModelConfigSnapshot, ModelProvider } from '@/shared/model-config';

vi.mock('@/server/models/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/models/registry')>();
  return { ...actual, modelRegistry: vi.fn() };
});

const original = { mode: process.env.AI_MODE, key: process.env.AI_API_KEY, model: process.env.AI_MODEL };
function restore(name: string, value: string | undefined) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

let captured: { url: string; body: Record<string, any> }[] = [];
let content = '{"starter":"build"}';
let originalFetch: typeof globalThis.fetch;

function structuredResponse(body: string) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function configuredRegistry(codegenModel = 'codegen-model', routeModel = 'test-model') {
  const provider: ModelProvider = {
    id: 'primary', displayName: '主提供商', apiFormat: 'openai-chat', apiKeySource: 'env',
    baseUrl: 'https://models.example.test/v1', apiKeyEnv: 'AI_API_KEY',
    options: {}, enabled: true, createTime: '', updateTime: '',
  };
  const alias = (name: string, modelName: string): ModelAlias => ({
    alias: name, providerId: 'primary', modelName,
    capabilities: name === 'codegen.default'
      ? { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }
      : { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
    settings: {}, enabled: true, createTime: '', updateTime: '',
  });
  const snapshot: ModelConfigSnapshot = {
    revision: '1', refreshEpoch: '0',
    providers: [provider],
    aliases: [alias('codegen.default', codegenModel), alias('route.classify', routeModel)],
  };
  return createModelRegistry({
    store: { readConfigSnapshot: async () => snapshot, readRefreshEpoch: async () => '0' },
    clock: () => Date.now(),
  });
}

beforeEach(() => {
  captured = []; content = '{"starter":"build"}';
  process.env.AI_MODE = 'fixture'; process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model';
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url);
    captured.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return structuredResponse(content);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(modelRegistry).mockReset();
  restore('AI_MODE', original.mode); restore('AI_API_KEY', original.key); restore('AI_MODEL', original.model);
});

describe('应用起点路由（轻量静态页 / 构建类）', () => {
  it('fixture 模式默认选构建类，只有需求确实简单时才选轻量静态页', async () => {
    const prompts: [string, 'light' | 'build'][] = [
      ['购物商城前台', 'build'],
      ['用 React 做一个后台数据管理系统', 'build'],
      ['多页面展示站', 'build'],
      ['个人博客展示', 'build'],
      ['做一个网站', 'build'],
      ['登录注册系统', 'build'],
      ['简单的个人简介静态页', 'light'],
      ['单页产品介绍落地页', 'light'],
      ['生成验证-静态页', 'light'],
    ];
    for (const [prompt, expected] of prompts) expect(starterForPrompt(prompt), prompt).toBe(expected);
    await expect(routeStarter('简单的个人简介静态页')).resolves.toBe('light');
    await expect(routeStarter('购物商城前台')).resolves.toBe('build');
    expect(captured).toHaveLength(0);
  });

  it('provider 模式只请求二分类起点并解析结构化结果', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry());
    content = '{"starter":"light"}';
    await expect(routeStarter('简单介绍页')).resolves.toBe('light');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/chat/completions');
    expect(captured[0].body.model).toBe('test-model');
    expect(JSON.stringify(captured[0].body.messages)).toContain('简单介绍页');
    expect(captured[0].body.response_format).toMatchObject({ type: 'json_object' });
    const requestBody = JSON.stringify(captured[0].body);
    expect(requestBody).toMatch(/JSON/i);
    expect(requestBody).toContain('starter');
    expect(requestBody).toContain('light');
    expect(requestBody).toContain('build');
    expect(requestBody).not.toContain('vue_project');

    content = '{"starter":"build"}';
    await expect(routeStarter('数据仪表盘')).resolves.toBe('build');
    expect(captured).toHaveLength(2);
  });

  it('路由上游失败时返回 502/50200，提示改哪个别名且不泄露密钥', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry());
    globalThis.fetch = (async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode. key=sk-abcdef1234567890" },
    }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;

    const failure = await routeStarter('做一个博客').then(() => null, (error: unknown) => error as BusinessError);
    expect(failure).toBeInstanceOf(BusinessError);
    expect(failure?.status).toBe(502);
    expect(failure?.code).toBe(50200);
    expect(failure?.message).toContain('起点识别');
    expect(failure?.message).toContain('模型分配');
    expect(failure?.message).not.toContain('sk-abcdef1234567890');
  });

  it('注册表解析 codegen.default，与起点路由的 route.classify 相互独立', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry('codegen-model', 'route-model'));
    const model = await modelRegistry().resolveModel('codegen.default');
    await generateText({ model, prompt: '生成一个页面' });

    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe('codegen-model');
  });

  it('provider 模式拒绝模型返回的越界起点', async () => {
    process.env.AI_MODE = 'provider';
    vi.mocked(modelRegistry).mockReturnValue(configuredRegistry());
    content = '{"starter":"bogus"}';
    await expect(routeStarter('越界起点')).rejects.toThrow();
  });
});
