import { describe, expect, it } from 'vitest'
import { checkContextBudget } from '../src/agent/context-budget'

describe('context budget', () => {
  it('accepts small conversations', () => {
    const result = checkContextBudget({
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      contextWindowTokens: 10000,
      outputReserveTokens: 8192,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects conversations over the byte upper bound with a clear message', () => {
    const result = checkContextBudget({
      system: 'system',
      messages: [{ role: 'user', content: 'x'.repeat(5000) }],
      tools: {},
      contextWindowTokens: 2000,
      outputReserveTokens: 1000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('不会自动摘要或删除历史')
      expect(result.bytes).toBeGreaterThan(1000)
    }
  })
})
