import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  else if (existsSync('../.env')) process.loadEnvFile('../.env')
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://paimeng:paimeng@127.0.0.1:5433/paimeng',
  })
  const db = drizzle(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  await pool.end()
  console.log('数据库迁移完成')
}

void main()
