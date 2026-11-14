import assert from 'node:assert/strict'
import test from 'node:test'
import { createSseParser, type SseMessage } from '../src/utils/sse.ts'

test('parses CRLF events split across arbitrary chunk boundaries', () => {
  const messages: SseMessage[] = []
  const parser = createSseParser((message) => messages.push(message))
  for (const chunk of [
    'event: text-delta\r',
    '\ndata: {"text":"hel',
    'lo"}\r\n\r',
    '\nevent: run-finished\r\ndata: {"status":"completed"}\r\n\r\n',
  ]) {
    parser.push(chunk)
  }
  parser.flush()

  assert.deepEqual(messages, [
    { event: 'text-delta', data: '{"text":"hello"}' },
    { event: 'run-finished', data: '{"status":"completed"}' },
  ])
})

test('decodes UTF-8 text split inside a multi-byte character', () => {
  const messages: SseMessage[] = []
  const parser = createSseParser((message) => messages.push(message))
  const decoder = new TextDecoder()
  const bytes = new TextEncoder().encode('event: text-delta\ndata: {"text":"中文"}\n\n')
  for (let index = 0; index < bytes.length; index += 3) {
    parser.push(decoder.decode(bytes.subarray(index, index + 3), { stream: true }))
  }
  parser.push(decoder.decode())
  parser.flush()

  assert.equal(messages.length, 1)
  assert.equal(JSON.parse(messages[0].data).text, '中文')
})

test('joins multiple data lines and ignores comments', () => {
  const messages: SseMessage[] = []
  const parser = createSseParser((message) => messages.push(message))
  parser.push(': ping\n\n')
  parser.push('event: tool-finished\ndata: {"tool":"write",\ndata: "ok":true}\n\n')
  parser.flush()

  assert.deepEqual(messages, [{ event: 'tool-finished', data: '{"tool":"write",\n"ok":true}' }])
})

test('flushes a trailing event that has no blank line', () => {
  const messages: SseMessage[] = []
  const parser = createSseParser((message) => messages.push(message))
  parser.push('event: run-finished\r\ndata: {"status":"cancelled"}')
  parser.flush()

  assert.deepEqual(messages, [{ event: 'run-finished', data: '{"status":"cancelled"}' }])
})
