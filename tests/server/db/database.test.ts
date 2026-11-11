import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openDatabase } from '@/server/db/connection';
import { migrateDatabase } from '@/server/db/migrate';
import { chat, project } from '@/server/db/schema';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'paimeng-sqlite-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SQLite 存储基础', () => {
  it('新目录可以迁移两次；Drizzle 写入后重开数据库仍能读取，外键生效', () => {
    const filename = path.join(fixture(), 'nested', 'paimeng.sqlite');
    const sqlite = openDatabase(filename);
    try {
      migrateDatabase(sqlite);
      migrateDatabase(sqlite);
      const database = drizzle(sqlite);
      database
        .insert(project)
        .values({
          id: 'p1',
          name: '本地项目',
          workspacePath: '/tmp/example',
          fileIndex: {
            paths: [],
            truncated: false,
            limit: 5000,
            indexedAt: '2026-11-11T00:00:00.000Z',
          },
        })
        .run();
      database
        .insert(chat)
        .values({ id: 'c1', projectId: 'p1', title: '开发', modelId: 'model' })
        .run();
      expect(() =>
        database
          .insert(chat)
          .values({
            id: 'invalid',
            projectId: 'missing',
            title: '孤立对话',
            modelId: 'model',
          })
          .run(),
      ).toThrow();
      expect(sqlite.prepare('select count(*) as count from schema_migration').get()).toEqual({
        count: 1,
      });
      const names = sqlite.prepare("select name from sqlite_master where type = 'table'").all() as {
        name: string;
      }[];
      for (const removed of ['deploy', 'sandbox_session', 'version']) {
        expect(names.map((row) => row.name)).not.toContain(removed);
      }
    } finally {
      sqlite.close();
    }
    const reopened = openDatabase(filename);
    try {
      const stored = drizzle(reopened).select().from(project).get();
      expect(stored).toMatchObject({
        id: 'p1',
        workspacePath: '/tmp/example',
      });
      expect(stored?.createdAt).toBeInstanceOf(Date);
    } finally {
      reopened.close();
    }
  });

  it('已经应用的迁移被改写时拒绝，不静默覆盖', () => {
    const root = fixture();
    const file = path.join(root, '001_init.sql');
    writeFileSync(file, readFileSync('migrations/001_init.sql', 'utf8'));
    const sqlite = openDatabase(':memory:');
    try {
      migrateDatabase(sqlite, root);
      writeFileSync(file, 'create table different (id text);');
      expect(() => migrateDatabase(sqlite, root)).toThrow(/已应用但内容变了/);
    } finally {
      sqlite.close();
    }
  });

  it('失败的迁移整体回滚，不留下半张业务表或通过记录', () => {
    const root = fixture();
    writeFileSync(path.join(root, '001_bad.sql'), 'create table partial (id text); invalid sql;');
    const sqlite = openDatabase(':memory:');
    try {
      expect(() => migrateDatabase(sqlite, root)).toThrow();
      expect(
        sqlite.prepare("select name from sqlite_master where name = 'partial'").get(),
      ).toBeUndefined();
      expect(sqlite.prepare('select count(*) as count from schema_migration').get()).toEqual({
        count: 0,
      });
    } finally {
      sqlite.close();
    }
  });
});
