import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    userAccount: varchar('user_account', { length: 64 }).notNull(),
    userPassword: text('user_password').notNull(),
    userName: varchar('user_name', { length: 64 }).notNull().default(''),
    userAvatar: text('user_avatar'),
    userProfile: text('user_profile'),
    userRole: varchar('user_role', { length: 32 }).notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_user_account_uq').on(t.userAccount)],
)

export const apps = pgTable(
  'apps',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    appName: varchar('app_name', { length: 100 }).notNull(),
    initPrompt: text('init_prompt').notNull(),
    codeGenType: varchar('code_gen_type', { length: 20 }),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    execBlocked: boolean('exec_blocked').notNull().default(false),
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    deleteError: text('delete_error'),
    deleteNextRetryAt: timestamp('delete_next_retry_at', { withTimezone: true }),
    historyUsedBytes: bigint('history_used_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('apps_owner_idx').on(t.ownerId), index('apps_status_idx').on(t.status)],
)

export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_app_uq').on(t.appId)],
)

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    role: varchar('role', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_id_idx').on(t.conversationId, t.id)],
)

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    clientRequestId: varchar('client_request_id', { length: 64 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('running'),
    phase: varchar('phase', { length: 20 }).notNull().default('preparing'),
    stepCount: integer('step_count').notNull().default(0),
    repairCount: integer('repair_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 64 }),
    errorSummary: text('error_summary'),
    detailsStatus: varchar('details_status', { length: 20 }).notNull().default('pending'),
    detailsError: text('details_error'),
  },
  (t) => [
    uniqueIndex('runs_app_client_request_uq').on(t.appId, t.clientRequestId),
    index('runs_app_idx').on(t.appId, t.startedAt),
    uniqueIndex('runs_one_active_per_app_uq')
      .on(t.appId)
      .where(sql`status in ('running','cancelling')`),
    index('runs_status_idx').on(t.status),
  ],
)

export const agentSessionEntries = pgTable(
  'agent_session_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    entryType: varchar('entry_type', { length: 32 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_entries_conversation_seq_uq').on(t.conversationId, t.seq),
    index('session_entries_run_idx').on(t.runId),
  ],
)

export const runPlans = pgTable(
  'run_plans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    steps: jsonb('steps').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('run_plans_run_uq').on(t.runId), index('run_plans_app_idx').on(t.appId)],
)

export const runActivities = pgTable(
  'run_activities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_activities_run_idx').on(t.runId, t.id), index('run_activities_app_idx').on(t.appId)],
)

export const contentBlobs = pgTable(
  'content_blobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    size: integer('size').notNull(),
    content: bytea('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('content_blobs_app_sha_uq').on(t.appId, t.sha256),
    index('content_blobs_app_idx').on(t.appId),
  ],
)

export const runFiles = pgTable(
  'run_files',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    baseHash: varchar('base_hash', { length: 64 }),
    finalHash: varchar('final_hash', { length: 64 }),
    baseBlobId: uuid('base_blob_id').references(() => contentBlobs.id, { onDelete: 'set null' }),
    finalBlobId: uuid('final_blob_id').references(() => contentBlobs.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    linesAdded: integer('lines_added'),
    linesDeleted: integer('lines_deleted'),
    diffStatus: varchar('diff_status', { length: 20 }).notNull().default('pending'),
    diff: text('diff'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_files_run_path_uq').on(t.runId, t.path),
    index('run_files_app_idx').on(t.appId, t.runId),
  ],
)

export const runValidationLogs = pgTable(
  'run_validation_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    appId: integer('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    checkName: varchar('check_name', { length: 40 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    summary: text('summary'),
    logs: text('logs'),
    truncated: boolean('truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_validation_run_attempt_check_uq').on(t.runId, t.attempt, t.checkName),
    index('run_validation_run_idx').on(t.runId),
  ],
)

export type AppRow = typeof apps.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type RunRow = typeof agentRuns.$inferSelect
export type UserRow = typeof users.$inferSelect
export type SessionEntryRow = typeof agentSessionEntries.$inferSelect
export type RunPlanRow = typeof runPlans.$inferSelect
export type RunFileRow = typeof runFiles.$inferSelect
