import { getPool } from '../../src/server/infra/db';
import { issuePendingQuota } from '../../src/server/billing/quota';

/**
 * 每月限时积分补发入口：默认试运行，`--apply` 才写库。
 *
 * 常规路径是懒触发的——注册时与读取额度摘要（`GET billing/summary`）时自动补当期规则；
 * 这个入口只在停机跨月之后一次性补齐全库，或由外部 cron 定时调用。
 * 幂等键是 (user_id, period) 的规则行，所以反复跑不会多发。
 */
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
  throw new Error('--limit 必须是正整数');

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1)))
  throw new Error('仅允许对独立的 paimeng_app 库发放限时积分');

const run = await issuePendingQuota({ dryRun: !apply, limit });
console.log(
  `${apply ? '已发放' : '试运行（加 --apply 才写库）'}：账期 ${run.period}，扫描 ${run.scanned} 人，` +
    `新建规则行 ${run.issued} 条（正数 ${run.granted}，0 积分 ${run.zero}），合计 ${run.credits} 积分`,
);
if (run.operationId) console.log(`操作日志：${run.operationId}`);
if (run.failures.length)
  console.error(`失败 ${run.failures.length} 人：`, run.failures.slice(0, 10));
await getPool().end();
