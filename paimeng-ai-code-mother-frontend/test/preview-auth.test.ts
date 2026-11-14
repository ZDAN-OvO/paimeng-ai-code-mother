import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_AUTH_REFRESH_MS, shouldRefreshPreviewAuth } from '../src/utils/previewAuth.ts'

const base = {
  visible: true,
  hasPreview: true,
  lastAccessAt: 1_000_000,
  now: 1_000_000 + PREVIEW_AUTH_REFRESH_MS,
}

test('refreshes only after the five minute boundary', () => {
  assert.equal(shouldRefreshPreviewAuth(base), false)
  assert.equal(shouldRefreshPreviewAuth({ ...base, now: base.now + 1 }), true)
})

test('does not refresh while hidden or without a preview', () => {
  assert.equal(shouldRefreshPreviewAuth({ ...base, now: base.now + 1, visible: false }), false)
  assert.equal(shouldRefreshPreviewAuth({ ...base, now: base.now + 1, hasPreview: false }), false)
})
