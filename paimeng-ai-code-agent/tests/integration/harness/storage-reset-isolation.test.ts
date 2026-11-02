import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resetPostgresStorage } from '@/server/generation/durable/storage-pg';
import { storageResetDatabaseUrl } from '@/server/generation/durable/storage-reset-policy';

const supplied = process.env.DURABLE_PG_URL;
if (!supplied) throw new Error('Storage reset isolation requires an explicit exclusive DURABLE_PG_URL');
const firstUrl = storageResetDatabaseUrl(supplied);
const second = new URL(firstUrl);
second.pathname = second.pathname.replace(/_test$/, '_witness_test');
const secondUrl = storageResetDatabaseUrl(second.href);

describe('durable reset 的真实数据库隔离', () => {
  it('拒绝共享 _test 与开发库（包括无显式 options），不连接删除共享表', async () => {
    const invalid = new URL(firstUrl);
    for (const name of ['paimeng_agent', 'paimeng_agent_test']) {
      invalid.pathname = '/' + name;
      // 使用不可达端口：被拒须来自连接前的策略，而非一次失败的数据库连接。
      invalid.port = '1';
      await expect(resetPostgresStorage({ connectionString: invalid.href })).rejects.toThrow('explicitly named exclusive');
    }
    const previous = process.env.DURABLE_PG_URL;
    process.env.DURABLE_PG_URL = invalid.href;
    try { await expect(resetPostgresStorage()).rejects.toThrow('explicitly named exclusive'); }
    finally { process.env.DURABLE_PG_URL = previous; }
  });

  it('重置独占 A 的执行表时，独占 B 的同名表和 marker 保持完整', async () => {
    const clients = [new pg.Client({ connectionString: firstUrl }), new pg.Client({ connectionString: secondUrl })];
    await Promise.all(clients.map(client => client.connect()));
    const token = randomUUID();
    try {
      // 全部在本轮独占 A/B 数据库内；不读取、修改或清理 shared agent_test。
      for (const client of clients) {
        await client.query('CREATE TABLE IF NOT EXISTS reset_witness (token text primary key)');
        await client.query('INSERT INTO reset_witness VALUES ($1)', [token]);
      }
      await clients[1].query('CREATE TABLE IF NOT EXISTS durable_schema (sentinel text)');
      await clients[1].query('INSERT INTO durable_schema VALUES ($1)', [token]);
      await resetPostgresStorage({ connectionString: firstUrl });
      expect((await clients[1].query('SELECT sentinel FROM durable_schema WHERE sentinel = $1', [token])).rows).toEqual([{ sentinel: token }]);
      for (const client of clients) expect((await client.query('SELECT token FROM reset_witness WHERE token = $1', [token])).rows).toEqual([{ token }]);
    } finally {
      for (const client of clients) await client.query('DELETE FROM reset_witness WHERE token = $1', [token]);
      await clients[1].query('DELETE FROM durable_schema WHERE sentinel = $1', [token]);
      await Promise.all(clients.map(client => client.end()));
    }
  });
});
