import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { ChangeFile, FileIndex, Message, Part } from '@/shared/api/schemas';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const now = sql`(unixepoch('subsec') * 1000)`;

export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    templateId: text('template_id').notNull().default(''),
    workspacePath: text('workspace_path').notNull(),
    fileIndex: text('file_index', { mode: 'json' }).$type<FileIndex>(),
    createdAt: timestamp('created_at').notNull().default(now),
    updatedAt: timestamp('updated_at').notNull().default(now),
  },
  (table) => [uniqueIndex('project_workspace_path_unique').on(table.workspacePath)],
);

export const chat = sqliteTable(
  'chat',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    modelId: text('model_id').notNull(),
    createdAt: timestamp('created_at').notNull().default(now),
    updatedAt: timestamp('updated_at').notNull().default(now),
    archivedAt: timestamp('archived_at'),
  },
  (table) => [index('chat_project_updated_idx').on(table.projectId, table.updatedAt)],
);

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<Message['role']>().notNull(),
    parts: text('parts', { mode: 'json' }).$type<Part[]>().notNull(),
    status: text('status').$type<Message['status']>(),
    stopReason: text('stop_reason').$type<Message['stopReason']>(),
    error: text('error'),
    changeSetId: text('change_set_id'),
    runId: text('run_id'),
    createdAt: timestamp('created_at').notNull().default(now),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [
    uniqueIndex('message_chat_seq_unique').on(table.chatId, table.seq),
    index('message_chat_created_idx').on(table.chatId, table.createdAt),
  ],
);

export const changeSet = sqliteTable(
  'change_set',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    runId: text('run_id'),
    seq: integer('seq').notNull(),
    summary: text('summary').notNull().default(''),
    status: text('status').notNull().default('applied'),
    createdAt: timestamp('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('change_set_project_seq_unique').on(table.projectId, table.seq),
    index('change_set_project_created_idx').on(table.projectId, table.createdAt),
  ],
);

export const changeFile = sqliteTable(
  'change_file',
  {
    id: text('id').primaryKey(),
    changeSetId: text('change_set_id')
      .notNull()
      .references(() => changeSet.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    change: text('change').$type<ChangeFile['change']>().notNull(),
    source: text('source').$type<ChangeFile['source']>().notNull(),
    attribution: text('attribution').$type<ChangeFile['attribution']>().notNull(),
    undoState: text('undo_state').$type<ChangeFile['undoState']>().notNull().default('applied'),
    beforeBlob: text('before_blob'),
    afterBlob: text('after_blob'),
    beforeExists: integer('before_exists', { mode: 'boolean' }).notNull().default(false),
    afterExists: integer('after_exists', { mode: 'boolean' }).notNull().default(false),
    beforeSize: integer('before_size').notNull().default(0),
    afterSize: integer('after_size').notNull().default(0),
    beforeBinary: integer('before_binary', { mode: 'boolean' }).notNull().default(false),
    afterBinary: integer('after_binary', { mode: 'boolean' }).notNull().default(false),
    beforeMode: text('before_mode'),
    afterMode: text('after_mode'),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    binary: integer('binary', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at').notNull().default(now),
    undoneAt: timestamp('undone_at'),
  },
  (table) => [
    uniqueIndex('change_file_set_path_unique').on(table.changeSetId, table.path),
    index('change_file_path_idx').on(table.path),
  ],
);

export const agentRun = sqliteTable(
  'agent_run',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    userMessageId: text('user_message_id').notNull(),
    assistantMessageId: text('assistant_message_id').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(),
    stopReason: text('stop_reason'),
    error: text('error'),
    instanceId: text('instance_id').notNull(),
    stepCount: integer('step_count').notNull().default(0),
    pendingApprovalId: text('pending_approval_id'),
    changeSetId: text('change_set_id'),
    startedAt: timestamp('started_at').notNull().default(now),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [
    index('agent_run_chat_status_idx').on(table.chatId, table.status),
    uniqueIndex('agent_run_chat_active_unique')
      .on(table.chatId)
      .where(sql`status IN ('running', 'awaiting_approval')`),
  ],
);

export const agentStep = sqliteTable(
  'agent_step',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number').notNull(),
    messages: text('messages', { mode: 'json' }).$type<unknown[]>().notNull(),
    createdAt: timestamp('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('agent_step_run_step_unique').on(table.runId, table.stepNumber)],
);

export const toolExecution = sqliteTable(
  'tool_execution',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    state: text('state').notNull(),
    output: text('output'),
    error: text('error'),
    approvalId: text('approval_id'),
    startedAt: timestamp('started_at').notNull().default(now),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [uniqueIndex('tool_execution_run_call_unique').on(table.runId, table.toolCallId)],
);

export const approval = sqliteTable(
  'approval',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    command: text('command').notNull(),
    cwd: text('cwd').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').notNull().default(now),
    decidedAt: timestamp('decided_at'),
  },
  (table) => [
    index('approval_run_status_idx').on(table.runId, table.status),
    index('approval_chat_status_idx').on(table.chatId, table.status),
  ],
);

export const bashCommand = sqliteTable(
  'bash_command',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    command: text('command').notNull(),
    cwd: text('cwd').notNull(),
    status: text('status').notNull(),
    exitCode: integer('exit_code'),
    outputPath: text('output_path'),
    outputTruncated: integer('output_truncated', { mode: 'boolean' }).notNull().default(false),
    approvalId: text('approval_id'),
    beforeTree: text('before_tree'),
    afterTree: text('after_tree'),
    startedAt: timestamp('started_at').notNull().default(now),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [index('bash_run_idx').on(table.runId)],
);

export const fileOperation = sqliteTable(
  'file_operation',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    changeSetId: text('change_set_id'),
    path: text('path').notNull(),
    operation: text('operation').notNull(),
    source: text('source').notNull(),
    attribution: text('attribution').notNull(),
    state: text('state').notNull().default('committed'),
    beforeBlob: text('before_blob'),
    afterBlob: text('after_blob'),
    beforeExists: integer('before_exists'),
    afterExists: integer('after_exists'),
    beforeMode: text('before_mode'),
    afterMode: text('after_mode'),
    detail: text('detail'),
    createdAt: timestamp('created_at').notNull().default(now),
  },
  (table) => [
    index('file_operation_project_path_idx').on(table.projectId, table.path, table.createdAt),
  ],
);

export const snapshot = sqliteTable(
  'snapshot',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    phase: text('phase').notNull(),
    tree: text('tree').notNull(),
    createdAt: timestamp('created_at').notNull().default(now),
  },
  (table) => [index('snapshot_project_run_idx').on(table.projectId, table.runId)],
);

/** 技能只保留目录元信息，本片不执行导入、启用、信任或注入。 */
export const skill = sqliteTable(
  'skill',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    source: text('source').notNull(),
    filePath: text('file_path').notNull(),
    createdAt: timestamp('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('skill_source_slug_unique').on(table.source, table.slug)],
);
