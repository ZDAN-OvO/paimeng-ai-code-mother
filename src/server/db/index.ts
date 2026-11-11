import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openDatabase } from './connection';
import * as schema from './schema';

const shared = globalThis as typeof globalThis & { paimengSqlite?: Database.Database };

export function db() {
  shared.paimengSqlite ??= openDatabase();
  return drizzle(shared.paimengSqlite, { schema });
}

export async function ping(): Promise<boolean> {
  try {
    db().get('select 1');
    return true;
  } catch {
    return false;
  }
}
