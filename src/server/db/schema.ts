import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ChangeSet, EnvVar, Part, RunStatus } from '@/shared/api/schemas';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  templateId: text('template_id').notNull().default('auto'),
  workspacePath: text('workspace_path').notNull().unique(),
  env: text('env', { mode: 'json' }).$type<EnvVar[]>().notNull().default([]),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const chat = sqliteTable('chat', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => project.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  modelId: text('model_id').notNull(),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    parts: text('parts', { mode: 'json' }).$type<Part[]>().notNull(),
    status: text('status').$type<RunStatus>(),
    completionReviewed: integer('completion_reviewed', { mode: 'boolean' }),
    createdAt: text('created_at').notNull().default(now),
    finishedAt: text('finished_at'),
  },
  (table) => [uniqueIndex('message_chat_seq').on(table.chatId, table.seq)],
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
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    summary: text('summary').notNull(),
    status: text('status', { enum: ['applied', 'undone'] })
      .notNull()
      .default('applied'),
    changedFiles: text('changed_files', { mode: 'json' }).$type<string[]>().notNull(),
    before: text('before_files', { mode: 'json' }).$type<ChangeSet['before']>().notNull(),
    after: text('after_files', { mode: 'json' }).$type<ChangeSet['after']>().notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('change_set_project_seq').on(table.projectId, table.seq)],
);

export const skill = sqliteTable(
  'skill',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    description: text('description').notNull(),
    source: text('source', { enum: ['builtin', 'user'] }).notNull(),
    trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('skill_source_slug').on(table.source, table.slug)],
);
