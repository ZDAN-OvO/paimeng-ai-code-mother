import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * 输入护轨规则的外部文件加载。
 *
 * 词表与注入正则属于策略，不是代码：放在 `config/prompt-safety.json`，可用
 * `PROMPT_SAFETY_RULES_PATH` 指向别的文件（测试、灰度）。
 *
 * 失败一律抛错（fail-closed）：路径写错、JSON 坏掉、正则编不过，都不允许退化成
 * 「规则为空 = 全部放行」。规则只在首次使用时读取并缓存，改完文件需重启进程。
 */

const rulesSchema = z.object({
  $comment: z.string().optional(),
  sensitiveWords: z.array(z.string().min(1, '敏感词不能是空串')),
  injectionPatterns: z.array(z.string().min(1, '注入正则不能是空串')),
});

export type PromptSafetyRules = {
  /** 原样保留的敏感词，仅用于排查与测试。 */
  sensitiveWords: readonly string[];
  /** 已经转小写的敏感词，匹配时直接跟小写后的输入比较。 */
  lowercasedWords: readonly string[];
  injectionPatterns: readonly RegExp[];
};

export function defaultPromptSafetyRulesPath() {
  const override = process.env.PROMPT_SAFETY_RULES_PATH?.trim();
  return override ? override : join(process.cwd(), 'config', 'prompt-safety.json');
}

function parseRules(path: string, text: string): PromptSafetyRules {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (problem) {
    throw new Error(`输入护轨规则文件 ${path} 不是合法 JSON：${problem instanceof Error ? problem.message : String(problem)}`);
  }
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'} ${issue.message}`).join('；');
    throw new Error(`输入护轨规则文件 ${path} 结构不合法：${issues}`);
  }
  const injectionPatterns = parsed.data.injectionPatterns.map((source, index) => {
    try {
      // 不带 g / y：validatePrompt 用 test() 逐条判定，带状态标志会让同一输入的结果随调用次数变化。
      return new RegExp(source, 'i');
    } catch (problem) {
      throw new Error(`输入护轨规则文件 ${path} 第 ${index + 1} 条注入正则无效（${source}）：${problem instanceof Error ? problem.message : String(problem)}`);
    }
  });
  return {
    sensitiveWords: parsed.data.sensitiveWords,
    lowercasedWords: parsed.data.sensitiveWords.map(word => word.toLowerCase()),
    injectionPatterns,
  };
}

/** 纯加载，不做缓存；测试与需要临时规则的调用方直接用它。 */
export function loadPromptSafetyRules(path: string = defaultPromptSafetyRulesPath()): PromptSafetyRules {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (problem) {
    throw new Error(`无法读取输入护轨规则文件 ${path}：${problem instanceof Error ? problem.message : String(problem)}`);
  }
  return parseRules(path, text);
}

let cached: PromptSafetyRules | null = null;

/** 进程内缓存的规则；第一次调用时读取文件，之后不再读盘。 */
export function promptSafetyRules(): PromptSafetyRules {
  cached ??= loadPromptSafetyRules();
  return cached;
}

/** 仅供测试：清掉缓存，让下一次读取重新落盘读文件。 */
export function resetPromptSafetyRules() {
  cached = null;
}
