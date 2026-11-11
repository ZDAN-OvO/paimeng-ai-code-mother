import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function migrateDatabase(
  connection: Database.Database,
  directory = path.resolve('migrations'),
) {
  connection.exec(`
    create table if not exists schema_migration (
      name text primary key not null,
      checksum text not null,
      applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  const find = connection.prepare('select checksum from schema_migration where name = ?');
  const insert = connection.prepare('insert into schema_migration (name, checksum) values (?, ?)');
  const applied: string[] = [];
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(directory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    connection
      .transaction(() => {
        const previous = find.get(name) as { checksum: string } | undefined;
        if (previous) {
          if (previous.checksum !== checksum) throw new Error(`${name} 已应用但内容变了`);
          return;
        }
        connection.exec(sql);
        insert.run(name, checksum);
        applied.push(name);
      })
      .immediate();
  }
  return applied;
}
