import type { ModelMessage } from 'ai'

export interface BudgetInput {
  system: string
  messages: ModelMessage[]
  tools: Record<string, unknown>
  contextWindowTokens: number
  outputReserveTokens: number
}

export function checkContextBudget(input: BudgetInput): { ok: true; bytes: number } | { ok: false; message: string; bytes: number } {
  const payload = JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools })
  const bytes = Buffer.byteLength(payload, 'utf8')
  const limit = input.contextWindowTokens - input.outputReserveTokens
  if (bytes > limit) {
    return {
      ok: false,
      bytes,
      message: `上下文预算超限：本次请求至少需要 ${bytes} tokens（按 UTF-8 字节保守估算），配置窗口 ${input.contextWindowTokens}，为输出预留 ${input.outputReserveTokens}，可用 ${limit}。平台不会自动摘要或删除历史，请新建应用继续。`,
    }
  }
  return { ok: true, bytes }
}
