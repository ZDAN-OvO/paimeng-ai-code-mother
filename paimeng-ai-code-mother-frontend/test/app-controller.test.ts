import assert from 'node:assert/strict'
import test from 'node:test'
import { chatStreamEventType } from '../src/utils/chatStream.ts'

test('maps transient data chunks to the event names consumed by the chat page', () => {
  assert.equal(chatStreamEventType('data-model'), 'model-status')
  assert.equal(chatStreamEventType('data-preview'), 'preview-status')
  assert.equal(chatStreamEventType('data-run'), 'run-finished')
  assert.equal(chatStreamEventType('data-run-started'), 'run-started')
})
