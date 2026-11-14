import assert from 'node:assert/strict'
import test from 'node:test'
import { clampSplitWidth, defaultSplitWidth, parseStoredSplit } from '../src/utils/workspace.ts'

test('uses a narrower default below 1280px', () => {
  assert.equal(defaultSplitWidth(1440), 400)
  assert.equal(defaultSplitWidth(1100), 340)
})

test('keeps the preview at least 480px wide', () => {
  assert.equal(clampSplitWidth(200, 1024), 320)
  assert.equal(clampSplitWidth(900, 1024), 544)
  assert.equal(clampSplitWidth(900, 1440), 560)
})

test('falls back to the default for missing or invalid storage', () => {
  assert.equal(parseStoredSplit(null, 1440), 400)
  assert.equal(parseStoredSplit('not-a-number', 1440), 400)
  assert.equal(parseStoredSplit('999', 1024), 544)
})
