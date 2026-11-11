import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolLoopAgent } from 'ai';
import { describe, expect, it } from 'vitest';
import { createConfiguredModel } from '@/server/model/index';

describe('OpenAI-compatible 模型入口', () => {
  it('缺少模型名时给出配置提示，不发请求', () => {
    expect(() => createConfiguredModel({})).toThrow(/AI_MODEL/);
  });

  it('ToolLoopAgent 使用本地配置调用兼容接口并读回文本', async () => {
    let received: {
      path?: string;
      authorization?: string;
      body?: { model: string; messages: unknown[] };
    } = {};
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received = {
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'test-completion',
          object: 'chat.completion',
          created: 1,
          model: 'local-test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '兼容接口已连通' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const agent = new ToolLoopAgent({
        model: createConfiguredModel({
          AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          AI_MODEL: 'local-test-model',
          AI_API_KEY: 'test-key',
        }),
      });
      const result = await agent.generate({ prompt: '检查模型连接' });
      expect(result.text).toBe('兼容接口已连通');
      expect(received).toMatchObject({
        path: '/v1/chat/completions',
        authorization: 'Bearer test-key',
        body: { model: 'local-test-model' },
      });
      expect(received.body?.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
