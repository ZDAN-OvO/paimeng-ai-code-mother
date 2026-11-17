import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTurnBlocks, visibleTurnBlocks } from '../src/utils/turnBlocks.ts'

const text = (value: string) => ({ type: 'text', text: value, state: 'done' }) as never
const tool = (id: string, toolName: string) =>
  ({
    type: 'dynamic-tool',
    dynamic: true,
    toolCallId: id,
    toolName,
    state: 'output-available',
    input: {},
    output: {},
  }) as never
const steer = (id: string, value: string) =>
  ({
    type: 'data-steer',
    id: `steer:${id}`,
    data: { text: value, clientRequestId: id },
  }) as never

test('keeps text, tools, plans and later text in stored part order', () => {
  const blocks = buildTurnBlocks(
    [
      text('先检查目录。'),
      tool('ls', 'ls'),
      text('现在实现。'),
      {
        type: 'data-plan',
        id: 'plan:1',
        data: { revision: 1, steps: [{ id: '1', title: '实现', status: 'in_progress' }] },
      } as never,
      tool('write', 'write'),
      text('完成。'),
    ],
    'completed',
  )
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['text', 'tools', 'text', 'plan', 'tools', 'text'],
  )
})

test('only adjacent tools of the same category are grouped', () => {
  const blocks = buildTurnBlocks(
    [tool('read-1', 'read'), tool('grep', 'grep'), text('修改中'), tool('read-2', 'read')],
    'completed',
  )
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['tools', 'text', 'tools'],
  )
  assert.equal(blocks[0].type === 'tools' && blocks[0].group.entries.length, 2)
})

test('a late tool result remains at its original position', () => {
  const blocks = buildTurnBlocks([tool('read', 'read'), text('继续')], 'completed')
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['tools', 'text'],
  )
})

test('collapsed process keeps the final reply visible before trailing validation', () => {
  const parts = [
    text('先检查。'),
    tool('read', 'read'),
    text('开始修改。'),
    tool('edit', 'edit'),
    text('已完成。'),
    {
      type: 'data-validation',
      id: 'validation:1:build',
      data: { attempt: 1, check: 'build', status: 'passed' },
    } as never,
  ]
  const before = JSON.stringify(parts)
  const blocks = buildTurnBlocks(parts, 'completed')

  assert.deepEqual(visibleTurnBlocks(blocks, 'completed', false), [blocks[4]])
  assert.deepEqual(visibleTurnBlocks(blocks, 'completed', true), blocks)
  assert.equal(JSON.stringify(parts), before)
  assert.deepEqual(
    visibleTurnBlocks(buildTurnBlocks(JSON.parse(before), 'completed'), 'completed', false),
    [blocks[4]],
  )
})

test('text-only final reply and adjacent final text parts stay visible', () => {
  const blocks = buildTurnBlocks([text('完成。'), text('使用说明。')], 'completed')
  assert.deepEqual(visibleTurnBlocks(blocks, 'completed', false), blocks)
})

test('completed plan updates after the final reply do not hide the reply', () => {
  const blocks = buildTurnBlocks(
    [
      text('已完成。'),
      {
        type: 'data-plan',
        id: 'plan:2',
        data: {
          revision: 2,
          steps: [{ id: '1', title: '完成', status: 'completed' }],
        },
      } as never,
      {
        type: 'data-validation',
        id: 'validation:1:build',
        data: { attempt: 1, check: 'build', status: 'passed' },
      } as never,
    ],
    'completed',
  )
  assert.deepEqual(visibleTurnBlocks(blocks, 'completed', false), [blocks[0]])
})

test('commentary before a later operation is not promoted to a final reply', () => {
  const blocks = buildTurnBlocks([text('开始修改。'), tool('edit', 'edit')], 'completed')
  assert.deepEqual(visibleTurnBlocks(blocks, 'completed', false), [])
  assert.deepEqual(visibleTurnBlocks(blocks, 'streaming', false), blocks)
  assert.deepEqual(visibleTurnBlocks(blocks, 'failed', false), [])
  assert.deepEqual(visibleTurnBlocks(blocks, 'cancelled', false), [])
})

test('collapsed turns keep steer bubbles in their original positions with the final reply', () => {
  const blocks = buildTurnBlocks(
    [
      text('开始处理。'),
      tool('read-1', 'read'),
      steer('request-1', '先保留现有导航'),
      tool('edit-1', 'edit'),
      steer('request-2', '再调整配色'),
      tool('build-1', 'build'),
      text('两处修改都已完成。'),
    ],
    'completed',
  )

  const visible = visibleTurnBlocks(blocks, 'completed', false)
  assert.deepEqual(
    visible.map((block) => block.type),
    ['steer', 'steer', 'text'],
  )
  assert.equal(visible[0]?.type === 'steer' && visible[0].steer.text, '先保留现有导航')
  assert.equal(visible[0]?.key, 'steer:request-1')
  assert.equal(visible[1]?.type === 'steer' && visible[1].steer.text, '再调整配色')
  assert.equal(visible[2]?.type === 'text' && visible[2].text, '两处修改都已完成。')
})

test('failed and cancelled turns keep steer bubbles and the last reply without later tools', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const blocks = buildTurnBlocks(
      [
        tool('edit-1', 'edit'),
        steer('request-1', '改成两列'),
        text('已保留两列布局，但后续验证未完成。'),
      ],
      status,
    )
    const visible = visibleTurnBlocks(blocks, status, false)
    assert.deepEqual(
      visible.map((block) => block.type),
      ['steer', 'text'],
    )
    assert.equal(
      visible[1]?.type === 'text' && visible[1].text,
      '已保留两列布局，但后续验证未完成。',
    )
  }
})

test('a steer arriving after the final reply does not hide that reply', () => {
  const blocks = buildTurnBlocks(
    [tool('build-1', 'build'), text('修改已经完成。'), steer('request-1', '收到，继续保持')],
    'completed',
  )
  const visible = visibleTurnBlocks(blocks, 'completed', false)
  assert.deepEqual(
    visible.map((block) => block.type),
    ['text', 'steer'],
  )
})
