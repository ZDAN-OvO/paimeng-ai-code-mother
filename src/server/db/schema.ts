import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const project = pgTable('project', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chat = pgTable('chat', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => project.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  modelId: text('model_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    parts: jsonb('parts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('message_chat_seq').on(table.chatId, table.seq)],
);

export const version = pgTable(
  'version',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    seq: integer('seq').notNull(),
    snapshotPath: text('snapshot_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('version_chat_seq').on(table.chatId, table.seq)],
);

export const skill = pgTable(
  'skill',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    slug: text('slug').notNull(),
    description: text('description').notNull(),
    source: text('source').notNull(),
    trusted: boolean('trusted').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('skill_owner_slug').on(table.ownerId, table.slug)],
);

export const deploy = pgTable('deploy', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => project.id, { onDelete: 'cascade' }),
  versionId: text('version_id').notNull(),
  deployKey: text('deploy_key').notNull().unique(),
  state: text('state').notNull(),
  artifactPath: text('artifact_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sandboxSession = pgTable('sandbox_session', {
  id: text('id').primaryKey(),
  chatId: text('chat_id')
    .notNull()
    .unique()
    .references(() => chat.id, { onDelete: 'cascade' }),
  containerId: text('container_id').notNull(),
  volume: text('volume').notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
