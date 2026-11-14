import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityGroupLabel,
  groupKindOf,
  groupStatusOf,
  groupTimelineEntries,
  type ToolTimelineEntry,
} from '../src/utils/agentActivity.ts'

function entry(id: string, tool: string, status: ToolTimelineEntry['status']): ToolTimelineEntry {
  return { id, tool, label: `${tool} ${id}`, status }
}

test('keeps interleaved operation groups in their original order', () => {
  const groups = groupTimelineEntries([
    entry('1', 'read', 'done'),
    entry('2', 'edit', 'done'),
    entry('3', 'read', 'done'),
    entry('4', 'ls', 'done'),
    entry('5', 'write', 'done'),
  ])

  assert.equal(groups.length, 4)
  assert.equal(groups[0].kind, 'exploration')
  assert.deepEqual(
    groups[0].entries.map((item) => item.id),
    ['1'],
  )
  assert.equal(groups[1].kind, 'file-changes')
  assert.deepEqual(
    groups[1].entries.map((item) => item.id),
    ['2'],
  )
  assert.deepEqual(groups[2].entries.map((item) => item.id), ['3', '4'])
  assert.deepEqual(groups[3].entries.map((item) => item.id), ['5'])
})

test('keeps the first occurrence order of activity groups', () => {
  const groups = groupTimelineEntries([
    entry('1', 'edit', 'done'),
    entry('2', 'read', 'done'),
    entry('3', 'load_skill', 'done'),
  ])
  assert.deepEqual(
    groups.map((group) => group.kind),
    ['file-changes', 'exploration', 'tools'],
  )
})

test('derives group status without hiding partial failures', () => {
  assert.equal(groupStatusOf([entry('1', 'read', 'running')]), 'running')
  assert.equal(groupStatusOf([entry('1', 'read', 'failed')]), 'failed')
  assert.equal(
    groupStatusOf([entry('1', 'read', 'failed'), entry('2', 'read', 'done')]),
    'done',
  )
  assert.equal(
    groupStatusOf([entry('1', 'read', 'stopped'), entry('2', 'read', 'stopped')]),
    'stopped',
  )
})

test('maps tools to Codex-style activity groups and labels', () => {
  assert.equal(groupKindOf('grep'), 'exploration')
  assert.equal(groupKindOf('delete'), 'file-changes')
  assert.equal(groupKindOf('load_skill'), 'tools')
  assert.equal(groupKindOf('dependencies'), 'dependencies')
  assert.equal(activityGroupLabel('exploration', 'done'), '已读取文件')
  assert.equal(activityGroupLabel('file-changes', 'running'), '正在编辑文件')
  assert.equal(activityGroupLabel('tools', 'done'), '加载了工具')
})
