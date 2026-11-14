import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { createClient, RedisClientType } from 'redis'
import { AppConfigService } from '../config/config.module'

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: RedisClientType
  private connecting: Promise<unknown> | null = null

  constructor(private readonly config: AppConfigService) {
    this.client = createClient({ url: config.redisUrl })
    this.client.on('error', (err) => {
      // 连接错误由健康检查和调用方处理，避免进程因事件无监听而崩溃
      console.error('[redis] connection error', err instanceof Error ? err.message : err)
    })
  }

  async onModuleInit() {
    await this.ensureConnected()
  }

  async ensureConnected(): Promise<RedisClientType> {
    if (!this.client.isReady) {
      if (!this.connecting) {
        this.connecting = this.client.connect().finally(() => {
          this.connecting = null
        })
      }
      await this.connecting
    }
    return this.client
  }

  async ping() {
    await this.ensureConnected()
    return this.client.ping()
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.quit().catch(() => undefined)
    }
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
