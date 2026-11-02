/** Reset 只允许显式命名的独占测试库；共享 _test 与生产库在连接前拒绝。 */
export function storageResetDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('Storage reset requires a Postgres URL');
  const name = url.pathname.slice(1);
  if (name.length > 63 || !/^paimeng_agent_[a-z0-9][a-z0-9_]*_test$/.test(name)) {
    throw new Error('Storage reset requires an explicitly named exclusive paimeng_agent_<run>_test database');
  }
  for (const key of url.searchParams.keys()) throw new Error(`Storage reset URL does not permit query options (${key})`);
  return url.href;
}
