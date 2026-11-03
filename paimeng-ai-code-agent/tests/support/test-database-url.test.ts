import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database-url';
const source = 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_app';
const target = 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_app_test';
describe('集成测试数据库选择边界', () => {
  it('将专用开发库 URL 转换为测试库，重复执行保持同一目标', () => {
    expect(testDatabaseUrl(source)).toBe(target);
    expect(testDatabaseUrl(target)).toBe(target);
  });
  it('拒绝旧库、未知库、非 Postgres URL 和无效 URL', () => {
    for (const raw of [source.replace('paimeng_app', 'paimeng'), source.replace('paimeng_app', 'another_database'), source.replace('paimeng_app', 'paimeng_agent'), source.replace('postgres:', 'mysql:'), source.replace('postgres:', 'https:'), '']) expect(() => testDatabaseUrl(raw)).toThrow();
  });
  it('保留显式命名的独占库，避免与同一台机器上的其它 worktree 互相重置', () => {
    const exclusive = 'postgres://postgres:postgres@127.0.0.1:5432/paimeng_app_rt136_140_test';
    expect(testDatabaseUrl(exclusive)).toBe(exclusive);
    // 名字必须带轮次标识并以 _test 结尾；开发库和其它任意库名一律拒绝。
    for (const name of ['paimeng_app_rt136', 'paimeng_app_140_test', 'paimeng_app_RT136_test', 'paimeng_app__test', 'paimeng_app_test2']) {
      expect(() => testDatabaseUrl(source.replace('paimeng_app', name))).toThrow();
    }
  });
  it('拒绝可能覆盖连接目标的查询选项', () => {
    for (const query of ['database=postgres', 'host=external.invalid', 'port=5432', 'options=-c%20search_path%3Dpublic']) expect(() => testDatabaseUrl(source + '?' + query)).toThrow('query option');
  });
});
