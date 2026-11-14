import { describe, expect, it } from 'vitest'
import { truncateBytes } from '../src/common/truncate'

describe('tool output truncation', () => {
  it('keeps content at the exact byte limit unchanged', () => {
    const result = truncateBytes('abc', 3)
    expect(result.text).toBe('abc')
    expect(result.truncated).toBe(false)
    expect(result.originalBytes).toBe(3)
  })

  it('truncates one byte over the limit and reports the original size', () => {
    const result = truncateBytes('abcd', 3)
    expect(result.text.startsWith('abc')).toBe(true)
    expect(result.text).toContain('输出已截断')
    expect(result.text).toContain('原始 4 字节')
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(4)
  })
})
