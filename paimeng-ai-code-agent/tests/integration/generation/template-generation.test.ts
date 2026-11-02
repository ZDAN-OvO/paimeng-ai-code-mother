import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { db, getPool, now } from '@/server/infra/db';
import { users, apps, generations, leases } from '@/server/infra/schema';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import { publicUser } from '@/server/auth/auth';
import { createApp, getApp } from '@/server/business';
import { workspace, readProjectFile } from '@/server/workspace/workspace';
import type { CodeGenType, User } from '@/shared/contracts';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

let actor: User;
const created: { id: string; codeGenType: CodeGenType }[] = [];

beforeAll(async () => {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'ts_template_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
});
afterAll(async () => {
  for (const app of created) {
    for (const table of [leases, generations]) await db().delete(table).where(eq(table.appId, BigInt(app.id)));
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await rm(workspace(app), { recursive: true, force: true });
  }
  if (actor) {
    await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  }
  await getPool().end();
});

it('显式选择只提供轻量静态页与 React 厚架子，旧模板仍可按类型回退', async () => {
  const light = await createApp({ initPrompt: '简单网页', templateId: 'html' }, actor);
  created.push({ id: light, codeGenType: 'html' });
  expect(await getApp(light, actor)).toMatchObject({ codeGenType: 'html', template: { id: 'html', version: '1.0.0' }, sourceAvailable: true, previewUrl: null });

  const thick = await createApp({ initPrompt: '简单网页', templateId: 'react-ts' }, actor);
  created.push({ id: thick, codeGenType: 'react_project' });
  expect(await getApp(thick, actor)).toMatchObject({ codeGenType: 'react_project', template: { id: 'react-ts', version: '2.0.0' }, sourceAvailable: true, previewUrl: null });
  expect(await readProjectFile({ id: thick, codeGenType: 'react_project' }, 'src/pages/home.tsx')).toContain('内容运营工作台');
  expect(await readProjectFile({ id: thick, codeGenType: 'react_project' }, 'pnpm-lock.yaml')).toContain('lockfileVersion');

  // 旧模板保留解析与代码路径：显式 id 或旧 codeGenType 仍能建出对应工程。
  const vue = await createApp({ initPrompt: '商城管理后台', templateId: 'vue-ts' }, actor);
  created.push({ id: vue, codeGenType: 'vue_project' });
  expect(await getApp(vue, actor)).toMatchObject({ codeGenType: 'vue_project', template: { id: 'vue-ts', version: '1.0.0' } });
  expect(await readProjectFile({ id: vue, codeGenType: 'vue_project' }, 'src/App.vue')).toContain('今日计划');

  const multi = await createApp({ initPrompt: '多文件静态网站', templateId: 'multi-file' }, actor);
  created.push({ id: multi, codeGenType: 'multi_file' });
  expect((await getApp(multi, actor)).template).toEqual({ id: 'multi-file', version: '1.0.0' });

  const legacyVue = await createApp({ initPrompt: '简单网页', codeGenType: 'vue_project' }, actor);
  created.push({ id: legacyVue, codeGenType: 'vue_project' });
  expect((await getApp(legacyVue, actor)).template).toEqual({ id: 'vue-ts', version: '1.0.0' });
  const legacyReact = await createApp({ initPrompt: '简单网页', codeGenType: 'react_project' }, actor);
  created.push({ id: legacyReact, codeGenType: 'react_project' });
  expect((await getApp(legacyReact, actor)).template).toEqual({ id: 'react-ts', version: '2.0.0' });

  await expect(createApp({ initPrompt: '简单网页', templateId: 'missing' }, actor)).rejects.toThrow();
  await expect(createApp({ initPrompt: '简单网页', templateId: 'react-ts', codeGenType: 'html' }, actor)).rejects.toThrow('模板与应用类型不匹配');
});

it('自动选择只做二分类：默认构建类，需求确实简单时走轻量静态页', async () => {
  const simple = await createApp({ initPrompt: '做一个简单的个人简介静态页' }, actor);
  created.push({ id: simple, codeGenType: 'html' });
  expect(await getApp(simple, actor)).toMatchObject({ codeGenType: 'html', template: { id: 'html', version: '1.0.0' } });

  const complex = await createApp({ initPrompt: '做一个内容运营后台管理系统，含登录、数据看板和多页面路由' }, actor);
  created.push({ id: complex, codeGenType: 'react_project' });
  expect(await getApp(complex, actor)).toMatchObject({ codeGenType: 'react_project', template: { id: 'react-ts', version: '2.0.0' } });
  expect(await readProjectFile({ id: complex, codeGenType: 'react_project' }, 'src/App.tsx')).toContain('react-router');

  // 没有明显线索时也按构建类处理，轻量路径不会成为默认。
  const unclear = await createApp({ initPrompt: '做一个网站' }, actor);
  created.push({ id: unclear, codeGenType: 'react_project' });
  expect((await getApp(unclear, actor)).template).toEqual({ id: 'react-ts', version: '2.0.0' });
});
