import { getPool } from '../../src/server/infra/db';
import { pendingExpiryStats, sweepExpiry } from '../../src/server/billing/expiry';
import { finishOperation, startOperation } from '../../src/server/billing/operations';
import { periodOf } from '../../src/server/billing/period';

/**
 * 过期扫描入口：给每个还有未写出过期余量的用户补写 `kind='expire'` 的账本行。
 *
 * 常规路径是懒触发的；这个入口用于停机跨月之后一次性补齐，或交给外部 cron。
 * 幂等（每人每期一条），所以反复跑不会重复写；`--dry-run` 只报人数。
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1))) throw new Error('仅允许对独立的 paimeng_app 库执行过期扫描');

const at = new Date();
const period = periodOf(at);
if (dryRun) {
  const stats = await pendingExpiryStats(at);
  console.log(`试运行（不写库）：账期 ${period}，涉及 ${stats.users} 人，待写过期行 ${stats.credits} 积分`);
  await getPool().end();
  process.exit(0);
}
const operationId = await startOperation({ kind: 'expire_sweep', period, operatorId: null, targetCount: 0 });
const result = await sweepExpiry(at);
await finishOperation(operationId, {
  issuedCount: result.entries,
  skippedCount: 0,
  failedCount: 0,
  credits: 0,
  failures: [],
});
console.log(`已执行：账期 ${period}，涉及 ${result.users} 人，写出 ${result.entries} 条过期行`);
await getPool().end();
