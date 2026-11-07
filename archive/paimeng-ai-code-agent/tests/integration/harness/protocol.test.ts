import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, now } from '@/server/infra/db';
import { apps, users } from '@/server/infra/schema';
import { publicUser } from '@/server/auth/auth';
import { createApp } from '@/server/business';
import { harnessProtocol } from '@/server/generation/durable/protocol';
import { harnessChatResponse } from '@/server/generation/durable-engine';
import { postgresReachable, postgresUrl, productRoot } from './support';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const postgresReady = await postgresReachable(postgresUrl);
if (!postgresReady)
  process.stderr.write(
    `[app-runtime-p01] 跳过协议混版用例：Postgres 不可达（${postgresUrl}），先跑 npm run durable:pg -- start\n`,
  );

/**
 * 只回答 /health 的假 harness：它是「重启前仍在跑的旧常驻进程」。
 * 除了 /health 之外任何请求都记下来——协议门禁必须在第一次工具调用前就拒绝。
 */
function startOldHarness(
  protocol: number,
): Promise<{ server: Server; url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    paths.push(pathname);
    if (pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, protocol }));
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: '旧 harness 不该收到这个请求' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, paths });
    });
  });
}

describe.skipIf(!postgresReady)('harness 协议门禁', () => {
  let userId: bigint;
  let appId: string;
  let appWorkspace: string;
  let stub: Awaited<ReturnType<typeof startOldHarness>>;
  const previousUrl = process.env.DURABLE_HARNESS_URL;

  beforeAll(async () => {
    userId = BigInt(randomUUID().replace(/\D/g, '').slice(0, 15));
    await db()
      .insert(users)
      .values({
        id: userId,
        userAccount: 'protocol_account_' + randomUUID(),
        userPassword: 'unused',
        userRole: 'user',
        createTime: now(),
        updateTime: now(),
      });
    const [row] = await db().select().from(users).where(eq(users.id, userId));
    const actor = publicUser(row);
    appId = await createApp({ initPrompt: '协议门禁验收', codeGenType: 'html' }, actor);
    appWorkspace = join(productRoot, 'runtime', 'code_output', `html_${appId}`);
    stub = await startOldHarness(harnessProtocol - 1);
    process.env.DURABLE_HARNESS_URL = stub.url;
  }, 60_000);

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.DURABLE_HARNESS_URL;
    else process.env.DURABLE_HARNESS_URL = previousUrl;
    if (stub) await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    if (appId) {
      await db()
        .delete(apps)
        .where(eq(apps.id, BigInt(appId)));
      await rm(appWorkspace, { recursive: true, force: true });
    }
    if (userId) await db().delete(users).where(eq(users.id, userId));
  }, 60_000);

  it('新 Next 在工具执行前拒绝旧常驻 harness', async () => {
    const [row] = await db().select().from(users).where(eq(users.id, userId));
    const actor = publicUser(row);
    const requestId = randomUUID();
    await expect(
      harnessChatResponse(
        new Request('http://localhost:3000/api/app/chat/gen/code'),
        {
          appId,
          requestId,
          message: {
            id: requestId,
            role: 'user',
            parts: [{ type: 'text', text: '协议门禁验收' }],
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 50301,
      message: expect.stringContaining('harness 版本不匹配'),
    });

    // 门禁只查了 /health：没有任何会话提交或 git 工具调用落到旧进程上。
    expect(stub.paths).toEqual(['/health']);
    // 旧 ensureVersionRepo 会在工作区重建仓库；拒绝路径不允许留下任何 Git 元数据。
    expect(existsSync(join(appWorkspace, '.git'))).toBe(false);
  }, 60_000);
});
