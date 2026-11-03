import { getPool, db } from '../../src/server/infra/db';
import { rebuildBalance } from '../../src/server/billing/ledger';
import { sql } from 'drizzle-orm';

/**
 * 对账入口：逐用户比较 `credit_balance.available` 与 `credit_ledger` 求和。
 * 默认只报告；`--apply` 按账本重写快照（不动账本），`--user <id>` 只看一个人。
 *
 *   npm run billing:verify-ledger
 *   npm run billing:verify-ledger -- --user 123
 *   npm run billing:verify-ledger -- --apply
 */
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIndex = args.indexOf('--user');
const userId = userIndex >= 0 ? args[userIndex + 1] : undefined;
if (userId !== undefined && !/^\d+$/u.test(userId)) throw new Error('--user 需要数字用户 ID');

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1)))
  throw new Error('仅允许对独立的 paimeng_app 库做对账');

const rows = await db().execute(sql`
  select t.user_id, t.expected, coalesce(b.available, 0) as actual
  from (select user_id, sum(credits) as expected from credit_ledger group by user_id) t
  left join credit_balance b on b.user_id = t.user_id
  where (${userId ?? null}::bigint is null or t.user_id = ${userId ?? null})
  order by t.user_id`);
const drift = rows.rows.filter((row) => Number(row.expected) !== Number(row.actual));
console.log(`对账 ${rows.rows.length} 人，漂移 ${drift.length} 人`);
for (const row of drift) {
  console.log(
    `- 用户 ${row.user_id}：账本 ${row.expected}，快照 ${row.actual}，差异 ${Number(row.actual) - Number(row.expected)}`,
  );
}
if (apply && drift.length) {
  for (const row of drift) await rebuildBalance(String(row.user_id));
  console.log(`已按账本重写 ${drift.length} 个用户的快照`);
} else if (drift.length) {
  console.log('加 --apply 会按账本重写这些用户的快照。');
}
await getPool().end();
