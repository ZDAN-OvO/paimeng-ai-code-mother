import { storageResetDatabaseUrl } from '../../src/server/generation/durable/storage-reset-policy';

/**
 * 本轮独占的产品测试库：`paimeng_app_<run>_test`。
 *
 * 共享的 `paimeng_app_test` 会被同一台机器上其它 worktree 的集成 harness 重置（它按自己的
 * 迁移集重建存储），两边的表结构会互相覆盖。需要稳定验证的长批次（system / E2E）因此给
 * 自己开一段独占库：名字必须显式带上轮次标识，迁移与清理都只发生在这一段里。
 */
const exclusive = /^\/paimeng_app_[a-z][a-z0-9_]*_test$/;

export function testDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('Integration tests require a Postgres URL');
  for (const key of url.searchParams.keys()) throw new Error(`Integration test database URL does not permit query options (${key})`);
  // 独占库原样保留；共享库仍统一落到 paimeng_app_test。
  if (exclusive.test(url.pathname) && url.pathname.length <= 63) return url.href;
  if (!['/paimeng_app', '/paimeng_app_test'].includes(url.pathname)) throw new Error('Integration tests require the dedicated app test database');
  url.pathname = '/paimeng_app_test';
  return url.href;
}

export function storageTestDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('The harness storage requires a Postgres URL');
  if (!['/paimeng_agent', '/paimeng_agent_test'].includes(url.pathname)) return storageResetDatabaseUrl(raw);
  for (const key of url.searchParams.keys()) throw new Error(`Harness storage URL does not permit query options (${key})`);
  url.pathname = '/paimeng_agent_test';
  return url.href;
}
