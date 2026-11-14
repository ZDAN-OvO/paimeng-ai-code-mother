import { describe, expect, it } from 'vitest'
import { shouldRecyclePreview } from '../src/preview/preview-policy'

const base = {
  status: 'running' as const,
  kind: 'vue' as const,
  hasRunningRun: false,
  lastHeartbeat: 1_000_000,
  now: 1_000_000 + 15 * 60 * 1000 + 1,
  idleMs: 15 * 60 * 1000,
}

describe('preview recycle policy', () => {
  it('recycles an idle build preview after the idle window', () => {
    expect(shouldRecyclePreview(base)).toBe(true)
  })

  it('does not recycle static previews or previews with a running run', () => {
    expect(shouldRecyclePreview({ ...base, kind: 'static' })).toBe(false)
    expect(shouldRecyclePreview({ ...base, hasRunningRun: true })).toBe(false)
  })

  it('does not recycle at the exact boundary or when not running', () => {
    expect(shouldRecyclePreview({ ...base, now: base.lastHeartbeat + base.idleMs })).toBe(false)
    expect(shouldRecyclePreview({ ...base, status: 'starting' })).toBe(false)
  })
})
