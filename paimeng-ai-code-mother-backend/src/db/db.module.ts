import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { AppConfigService } from '../config/config.module'
import * as schema from './schema'

export type Database = NodePgDatabase<typeof schema>

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool
  readonly db: Database

  constructor(config: AppConfigService) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    this.db = drizzle(this.pool, { schema })
  }

  async ping() {
    await this.pool.query('select 1')
  }

  async onModuleDestroy() {
    try {
      await this.pool.end()
    } catch {
      /* 进程退出阶段连接池可能已被关闭，忽略 */
    }
  }
}

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
