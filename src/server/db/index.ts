import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未设置，复制 .env.example 为 .env 后再启动');
  return url;
}

const globalForDb = globalThis as unknown as { paimengPool?: Pool };

export function pool(): Pool {
  globalForDb.paimengPool ??= new Pool({ connectionString: connectionString(), max: 10 });
  return globalForDb.paimengPool;
}

export function db() {
  return drizzle(pool(), { schema });
}

export async function ping(): Promise<boolean> {
  try {
    await pool().query('select 1');
    return true;
  } catch {
    return false;
  }
}
