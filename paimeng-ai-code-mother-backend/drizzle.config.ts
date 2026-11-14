import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://paimeng:paimeng@127.0.0.1:5433/paimeng',
  },
  strict: true,
  verbose: true,
})
