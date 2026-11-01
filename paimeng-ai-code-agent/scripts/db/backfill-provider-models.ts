import { getPool } from '../../src/server/infra/db';
import { BusinessError } from '../../src/server/infra/http';
import { applyProviderModelBackfill, planProviderModelBackfill } from '../../src/server/models/provider-model-backfill';

/**
 * 提供商模型回填的运维入口（docs/plans/provider-model-billing.md P2）。
 * 默认 dry-run，打印与 apply 相同的计划；`--apply` 才写库，并且必须带上预检里的 expectedRevision。
 *
 *   npm run db:backfill-provider-models
 *   npm run db:backfill-provider-models -- --apply --expect-revision 12
 *
 * 只动 provider_model、model_alias.provider_model_id、credit_rate_card.provider_model_id；
 * 不触碰步骤、账单、余额或任何结算路径。
 */

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('用法：npm run db:backfill-provider-models [-- --apply --expect-revision <revision>]');
  process.exit(0);
}

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1))) throw new Error('仅允许对独立的 paimeng_app 库执行提供商模型回填');

const apply = args.includes('--apply');

function optionOf(flag: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
  return value;
}

const expectedRevision = optionOf('--expect-revision');
if (expectedRevision !== undefined && !/^\d+$/.test(expectedRevision)) throw new Error('--expect-revision 需要十进制整数');
if (apply && expectedRevision === undefined) throw new Error('--apply 需要同时提供 --expect-revision（取 dry-run 报告里的 expectedRevision）');

try {
  const plan = await planProviderModelBackfill();
  console.log(JSON.stringify(plan, null, 2));
  console.log(`预检：模型待创建 ${plan.counts.modelsToCreate}，槽位待关联 ${plan.counts.aliasesToLink}，费率待关联 ${plan.counts.ratesToLink}，冲突 ${plan.counts.conflicts}，错链费率 ${plan.rates.mismatched.length}`);
  if (plan.conflicts.length) {
    console.error('存在冲突，未写入任何变更；请先确认能力/兼容声明，再重新预检。');
    process.exitCode = 2;
  } else if (!apply) {
    console.log(`dry-run 未写库；确认后执行 --apply --expect-revision ${plan.expectedRevision}`);
  } else {
    const result = await applyProviderModelBackfill(expectedRevision!);
    console.log(`已应用：新建模型 ${result.createdModels}，关联槽位 ${result.linkedAliases}，关联费率 ${result.linkedRates}，revision ${result.revision}，refreshEpoch ${result.refreshEpoch}`);
  }
} catch (error) {
  if (error instanceof BusinessError && error.code === 40905) {
    console.error(`回填中止：${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof BusinessError && error.code === 40901) {
    console.error('配置在预检后已变化；请重新 dry-run 获取 expectedRevision 后再 apply。');
    process.exitCode = 2;
  } else {
    console.error(`回填失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  await getPool().end();
}
