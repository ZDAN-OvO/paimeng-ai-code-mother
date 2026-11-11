import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openDatabase } from './connection';
import { migrateDatabase } from './migrate';
import * as schema from './schema';

const shared = globalThis as typeof globalThis & {
  paimengSqlite?: Database.Database;
  paimengInstanceId?: string;
};

/** 同一进程内只开一个连接；Next 的开发热更新也复用这个连接。 */
export function sqlite(): Database.Database {
  if (!shared.paimengSqlite) {
    const connection = openDatabase();
    migrateDatabase(connection);
    shared.paimengSqlite = connection;
  }
  return shared.paimengSqlite;
}

export function db() {
  return drizzle(sqlite(), { schema });
}

/** 进程启动标识，用来区分服务重启和普通热更新。 */
export function instanceId(): string {
  shared.paimengInstanceId ??= randomUUID();
  return shared.paimengInstanceId;
}

export function ping(): boolean {
  try {
    sqlite().prepare('select 1').get();
    return true;
  } catch {
    return false;
  }
}
