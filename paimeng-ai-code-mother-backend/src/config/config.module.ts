import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common'
import { resolve } from 'node:path'
import { Env, loadEnv } from './env'

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly env: Env

  constructor() {
    this.env = loadEnv()
  }

  onModuleInit() {
    this.runtimeRoot = resolve(this.env.RUNTIME_ROOT)
    this.logDir = resolve(this.env.LOG_DIR)
  }

  runtimeRoot = resolve('./runtime')
  logDir = resolve('./runtime/logs')

  get nodeEnv() {
    return this.env.NODE_ENV
  }
  get isProduction() {
    return this.env.NODE_ENV === 'production'
  }
  get port() {
    return this.env.PORT
  }
  get apiPrefix() {
    return this.env.API_PREFIX
  }
  get mainOrigin() {
    return this.env.MAIN_ORIGIN.replace(/\/$/, '')
  }
  get allowedOrigins(): string[] {
    return this.env.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean)
  }
  get previewDomain() {
    return this.env.PREVIEW_DOMAIN
  }
  get previewPort() {
    return this.env.PREVIEW_PORT
  }
  get previewScheme() {
    return this.env.PREVIEW_SCHEME
  }
  get sessionSecret() {
    return this.env.SESSION_SECRET
  }
  get sessionTtlMs() {
    return this.env.SESSION_TTL_MS
  }
  get databaseUrl() {
    return this.env.DATABASE_URL
  }
  get redisUrl() {
    return this.env.REDIS_URL
  }
  get aiBaseUrl() {
    return this.env.AI_BASE_URL
  }
  get aiApiKey() {
    return this.env.AI_KEY ?? this.env.AI_API_KEY ?? 'not-needed'
  }
  get aiModel() {
    return this.env.AI_MODEL
  }
  get aiContextWindowTokens() {
    return this.env.AI_CONTEXT_WINDOW_TOKENS
  }
  get aiOutputReserveTokens() {
    return this.env.AI_OUTPUT_RESERVE_TOKENS
  }
  get modelTimeoutMs() {
    return this.env.MODEL_TIMEOUT_MS
  }
  get runMaxSteps() {
    return this.env.RUN_MAX_STEPS
  }
  get runMaxDurationMs() {
    return this.env.RUN_MAX_DURATION_MS
  }
  get installTimeoutMs() {
    return this.env.INSTALL_TIMEOUT_MS
  }
  get buildTimeoutMs() {
    return this.env.BUILD_TIMEOUT_MS
  }
  get previewStartTimeoutMs() {
    return this.env.PREVIEW_START_TIMEOUT_MS
  }
  get maxRunsPerUser() {
    return this.env.MAX_RUNS_PER_USER
  }
  get maxActivePreviews() {
    return this.env.MAX_ACTIVE_PREVIEWS
  }
  get appRateLimitPerMinute() {
    return this.env.APP_RATE_LIMIT_PER_MINUTE
  }
  get maxFileBytes() {
    return this.env.MAX_FILE_BYTES
  }
  get maxSourceBytes() {
    return this.env.MAX_SOURCE_BYTES
  }
  get maxFileCount() {
    return this.env.MAX_FILE_COUNT
  }
  get runDetailQuotaBytes() {
    return this.env.RUN_DETAIL_QUOTA_BYTES
  }
  get runDetailManifestMaxBytes() {
    return this.env.RUN_DETAIL_MANIFEST_MAX_BYTES
  }
  get runDetailActivityMaxBytes() {
    return this.env.RUN_DETAIL_ACTIVITY_MAX_BYTES
  }
  get runDetailLogMaxBytes() {
    return this.env.RUN_DETAIL_LOG_MAX_BYTES
  }
  get runDetailDiffMaxBytes() {
    return this.env.RUN_DETAIL_DIFF_MAX_BYTES
  }
  get runDetailFinalizeTimeoutMs() {
    return this.env.RUN_DETAIL_FINALIZE_TIMEOUT_MS
  }
  get runDetailReserveBytes() {
    return this.env.MAX_SOURCE_BYTES * 2 + 32 * 1024 * 1024
  }
  get toolOutputMaxBytes() {
    return this.env.TOOL_OUTPUT_MAX_BYTES
  }
  get appLogMaxBytes() {
    return this.env.APP_LOG_MAX_BYTES
  }
  get dockerBin() {
    return this.env.DOCKER_BIN
  }
  get runtimeImage() {
    return this.env.RUNTIME_IMAGE
  }
  get appNetwork() {
    return this.env.DOCKER_APP_NETWORK
  }
  get installNetwork() {
    return this.env.DOCKER_INSTALL_NETWORK
  }
  get registryRelayPort() {
    return this.env.REGISTRY_RELAY_PORT
  }
  get registryUpstream() {
    return this.env.REGISTRY_UPSTREAM.replace(/\/$/, '')
  }
  get memoryTotalBudgetBytes() {
    return this.env.MEMORY_TOTAL_BUDGET_BYTES
  }
  get memoryHostReserveBytes() {
    return this.env.MEMORY_HOST_RESERVE_BYTES
  }

  get taskMemoryBytes() {
    return this.env.TASK_MEMORY_MB * 1024 * 1024
  }

  get taskMemoryDocker() {
    return `${this.env.TASK_MEMORY_MB}m`
  }
  get diskReserveBytes() {
    return this.env.DISK_RESERVE_BYTES
  }
  get previewIdleMs() {
    return this.env.PREVIEW_IDLE_MS
  }
  get previewAuthTtlMs() {
    return this.env.PREVIEW_AUTH_TTL_MS
  }
  get previewTicketTtlMs() {
    return this.env.PREVIEW_TICKET_TTL_MS
  }
  get previewCookieName() {
    return this.env.PREVIEW_COOKIE_NAME
  }
  get setupImageOnStart() {
    return this.env.SETUP_IMAGE_ON_START
  }

  get sourceRoot() {
    return resolve(this.runtimeRoot, 'output_code')
  }
  get depsRoot() {
    return resolve(this.runtimeRoot, 'deps')
  }
  get buildRoot() {
    return resolve(this.runtimeRoot, 'build')
  }
  get taskLogRoot() {
    return resolve(this.runtimeRoot, 'logs')
  }

  appSourceDir(appId: number) {
    return resolve(this.sourceRoot, String(appId))
  }
  appDepsDir(appId: number) {
    return resolve(this.depsRoot, String(appId))
  }
  appBuildDir(appId: number) {
    return resolve(this.buildRoot, String(appId))
  }
  previewUrl(appId: number) {
    return `${this.previewScheme}://app-${appId}.${this.previewDomain}:${this.previewPort}`
  }
}

@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
