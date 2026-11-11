import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function databasePath(): string {
  // 数据文件在用户机器上创建，不是构建时要收集的资源。
  return path.resolve(
    /* turbopackIgnore: true */ process.env.DATABASE_PATH || 'data/paimeng.sqlite',
  );
}

export function openDatabase(filename: string = databasePath()): Database.Database {
  if (filename !== ':memory:')
    mkdirSync(path.dirname(path.resolve(/* turbopackIgnore: true */ filename)), {
      recursive: true,
    });
  const connection = new Database(filename);
  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
