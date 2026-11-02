import { describe, expect, it } from 'vitest';
import { storageResetDatabaseUrl } from '@/server/generation/durable/storage-reset-policy';
import { storageTestDatabaseUrl } from '../../support/test-database-url';

const origin = 'postgres://postgres:unused@127.0.0.1:5432';
const dedicated = origin + '/paimeng_agent_rt136_139_test';

describe('durable reset 的独占测试数据库边界', () => {
  it('保留显式独占库，不把它重写到共享 storage test 库', () => {
    expect(storageResetDatabaseUrl(dedicated)).toBe(dedicated);
    expect(storageTestDatabaseUrl(dedicated)).toBe(dedicated);
  });

  it('reset 拒绝开发库、共享库、其他前缀、非法字符、过长名字及 query 覆盖', () => {
    for (const path of [
      '/paimeng_agent', '/paimeng_agent_test', '/paimeng_app_test', '/paimeng_agent__test',
      '/paimeng_agent_rt139', '/paimeng_agent_RT139_test', '/paimeng_agent_rt-139_test',
      '/paimeng_agent_rt139_test/extra', '/paimeng_agent_' + 'x'.repeat(63) + '_test',
      '/paimeng_agent_rt139_test?database=paimeng_agent', '/paimeng_agent_rt139_test?options=-c%20search_path%3Dpublic',
    ]) expect(() => storageResetDatabaseUrl(origin + path), path).toThrow();
    expect(() => storageResetDatabaseUrl('')).toThrow();
    expect(() => storageResetDatabaseUrl(dedicated.replace('postgres:', 'https:'))).toThrow();
  });
});
