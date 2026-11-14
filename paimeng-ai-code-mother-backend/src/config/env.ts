import { z } from 'zod'

const boolString = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8123),
  API_PREFIX: z.string().default('/api'),
  MAIN_ORIGIN: z.string().url().default('http://paimeng.localhost:8080'),
  ALLOWED_ORIGINS: z.string().default('http://paimeng.localhost:8080,http://localhost:5173'),
  PREVIEW_DOMAIN: z.string().default('preview.paimeng.localhost'),
  PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PREVIEW_SCHEME: z.enum(['http', 'https']).default('http'),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 3600 * 1000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AI_BASE_URL: z.string().url(),
  // 文档与 .env.example 使用 AI_KEY；保留 AI_API_KEY 作为兼容别名。
  AI_KEY: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().min(1),
  AI_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive(),
  AI_OUTPUT_RESERVE_TOKENS: z.coerce.number().int().positive().default(8192),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  RUN_MAX_STEPS: z.coerce.number().int().positive().default(100),
  RUN_MAX_DURATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  INSTALL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  BUILD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3 * 60 * 1000),
  PREVIEW_START_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_RUNS_PER_USER: z.coerce.number().int().positive().default(5),
  MAX_ACTIVE_PREVIEWS: z.coerce.number().int().positive().default(5),
  APP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  MAX_SOURCE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  MAX_FILE_COUNT: z.coerce.number().int().positive().default(5000),
  RUN_DETAIL_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  RUN_DETAIL_MANIFEST_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(16 * 1024 * 1024),
  RUN_DETAIL_ACTIVITY_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024),
  RUN_DETAIL_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  RUN_DETAIL_DIFF_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024),
  RUN_DETAIL_FINALIZE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TOOL_OUTPUT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024),
  APP_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  RUNTIME_ROOT: z.string().default('./runtime'),
  LOG_DIR: z.string().default('./runtime/logs'),
  DOCKER_BIN: z.string().default('docker'),
  RUNTIME_IMAGE: z.string().default('paimeng-app-runtime'),
  DOCKER_APP_NETWORK: z.string().default('paimeng-apps'),
  DOCKER_INSTALL_NETWORK: z.string().default('paimeng-install'),
  REGISTRY_RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(4873),
  REGISTRY_UPSTREAM: z.string().url().default('https://registry.npmjs.org'),
  MEMORY_TOTAL_BUDGET_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024 * 1024),
  MEMORY_HOST_RESERVE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  TASK_MEMORY_MB: z.coerce.number().int().positive().default(1536),
  DISK_RESERVE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  PREVIEW_IDLE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  PREVIEW_AUTH_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  PREVIEW_TICKET_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),
  PREVIEW_COOKIE_NAME: z.string().default('pm_preview'),
  SETUP_IMAGE_ON_START: boolString,
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`环境变量配置无效: ${messages}`)
  }
  return parsed.data
}
