import assert from 'node:assert/strict'
import test from 'node:test'
import { modelProgressText } from '../src/utils/modelProgress.ts'

test('write/edit progress shows received size without model, token or reasoning metadata', () => {
  assert.equal(modelProgressText({ status: 'running', step: 1 }), '正在思考…')
  assert.equal(
    modelProgressText({ status: 'streaming', tool: 'write', inputBytes: 8192 }),
    '正在编写文件 · 已接收 8 KB',
  )
  assert.equal(
    modelProgressText({
      status: 'streaming',
      tool: 'edit',
      inputBytes: 1536,
      model: 'secret-model',
      inputTokens: 1000,
      reasoningTokens: 9999,
    }),
    '正在修改文件 · 已接收 1.5 KB',
  )
  assert.equal(
    modelProgressText({ status: 'streaming', tool: 'unknown-internal-tool', inputBytes: 200 }),
    '正在生成…',
  )
})

test('finished, failed and invalid payloads clear transient progress; invalid sizes stay hidden', () => {
  for (const status of ['finished', 'failed', 'unknown']) {
    assert.equal(modelProgressText({ status, tool: 'write', inputBytes: 9000 }), '')
  }
  for (const inputBytes of [undefined, -1, NaN, Infinity, '8192']) {
    assert.equal(
      modelProgressText({ status: 'streaming', tool: 'write', inputBytes }),
      '正在编写文件',
    )
  }
})
