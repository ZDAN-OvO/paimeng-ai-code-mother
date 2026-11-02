import 'server-only';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import type { StarterKind } from '@/shared/templates';
import { modelRegistry } from '../models/registry';

export function aliasNotConfiguredMessage(alias: string): string {
 return `模型别名 ${alias} 未配置或未启用`;
}

export function isAliasNotConfigured(error: unknown, alias: string): boolean {
 return error instanceof BusinessError && error.status === 503 && error.code === 50300 && error.message === aliasNotConfiguredMessage(alias);
}

function routingFailureDetail(error: unknown) {
 const raw = error instanceof Error ? error.message : String(error);
 return raw.replace(/\s+/g, ' ').replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***').slice(0, 300) || '未知错误';
}

// 起点二分类的确定性规则：只有需求确实简单、没有多页面/交互/数据时才是轻量静态页；其余一律构建类。
const buildSignals = /管理|后台|登录|注册|购物|商城|订单|评论|数据|图表|动画|动效|多页面|多个页面|多文件|路由|交互|表单|搜索|筛选|支付|用户|接口|api|组件|系统|react|vue/i;
const lightSignals = /简单|静态|单页|单页面|纯展示|展示页|落地页|个人简介|简历页|landing/i;

export function starterForPrompt(prompt: string): StarterKind {
 if (buildSignals.test(prompt)) return 'build';
 return lightSignals.test(prompt) ? 'light' : 'build';
}

const starterSchema = z.object({ starter: z.enum(['light', 'build']) });

/**
 * 自动选择起点：只判断轻量静态页还是构建类应用，模板由 `templateForStarter` 决定。
 * 模型拿不准时也按构建类处理，轻量路径只留给确实简单的需求。
 */
export async function routeStarter(prompt: string): Promise<StarterKind> {
 if (getConfig().aiMode === 'fixture') return starterForPrompt(prompt);
 const model = await modelRegistry().resolveModel('route.classify');
 try {
  const result = await generateText({
   model,
   output: Output.object({ schema: starterSchema }),
   system: '你是应用起点路由器。需求包含多页面、路由、状态、表单、数据管理、登录或复杂交互时选择 build（构建类应用）；只有内容确实简单、单个静态展示页时才选择 light（轻量静态页）。拿不准时选择 build。只返回 JSON 对象，字段必须为 starter，其值只能是 light 或 build。例如 {"starter":"build"}。不要返回其他字段或解释。',
   prompt,
   abortSignal: AbortSignal.timeout(60000),
  });
  return result.output.starter;
 } catch (error) {
  // 上游拒答、超时或返回非法 JSON 都不能变成没有线索的 500：路由别名可以在管理端改。
  throw new BusinessError(502, 50200, `应用起点识别失败：${routingFailureDetail(error)}。请在「模型管理 → 模型分配」里更换类型路由槽位的提供商或模型后重试。`);
 }
}
