import { BusinessError } from '../infra/http';
import { promptSafetyRules } from './prompt-safety-rules';

/**
 * 生成入口的输入护轨：长度、空输入、敏感词、提示注入。
 *
 * 词表与正则不在代码里，见 `config/prompt-safety.json`（可用 `PROMPT_SAFETY_RULES_PATH` 覆盖），
 * 规则文件读不到或不合法会直接抛错，不会静默放行。
 */
export function validatePrompt(input: string) {
  const rules = promptSafetyRules();
  if (input.length > 1000) throw new BusinessError(400, 40000, '输入内容过长，不要超过 1000 字');
  if (!input.trim()) throw new BusinessError(400, 40000, '输入内容不能为空');
  const lowerInput = input.toLowerCase();
  if (rules.lowercasedWords.some((word) => lowerInput.includes(word)))
    throw new BusinessError(400, 40000, '输入包含不当内容，请修改后重试');
  if (rules.injectionPatterns.some((pattern) => pattern.test(input)))
    throw new BusinessError(400, 40000, '检测到恶意输入，请求被拒绝');
}
