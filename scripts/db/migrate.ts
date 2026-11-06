import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const dir = path.join(process.cwd(), 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未设置');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migration (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query<{ checksum: string }>(
        'select checksum from schema_migration where name = $1',
        [name],
      );
      if (rows[0]) {
        if (rows[0].checksum !== checksum) throw new Error(`${name} 已应用但内容变了`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migration (name, checksum) values ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('commit');
        console.log(`applied ${name}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
