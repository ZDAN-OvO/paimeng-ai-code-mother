export type ToolStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface ToolTimelineEntry {
  id: string
  tool: string
  input?: Record<string, unknown>
  label: string
  status: ToolStatus
  error?: string
  result?: Record<string, unknown>
}

export type ActivityGroupKind = 'exploration' | 'file-changes' | 'tools' | 'dependencies' | 'other'

export interface ActivityGroup {
  key: string
  kind: ActivityGroupKind
  entries: ToolTimelineEntry[]
  status: ToolStatus
}

export function groupKindOf(tool: string): ActivityGroupKind {
  if (tool === 'read' || tool === 'ls' || tool === 'grep' || tool === 'find') return 'exploration'
  if (tool === 'write' || tool === 'edit' || tool === 'delete') return 'file-changes'
  if (tool === 'load_skill' || tool === 'read_skill_resource') return 'tools'
  if (tool === 'dependencies') return 'dependencies'
  return 'other'
}

export function groupStatusOf(entries: ToolTimelineEntry[]): ToolStatus {
  if (entries.some((entry) => entry.status === 'running')) return 'running'
  if (entries.every((entry) => entry.status === 'failed')) return 'failed'
  if (entries.every((entry) => entry.status === 'stopped')) return 'stopped'
  return 'done'
}

export function groupTimelineEntries(entries: ToolTimelineEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const entry of entries) {
    const kind = groupKindOf(entry.tool)
    const current = groups[groups.length - 1]
    if (current?.kind === kind) current.entries.push(entry)
    else groups.push({ key: entry.id, kind, entries: [entry], status: 'running' })
  }
  return groups.map((group) => ({
    ...group,
    status: groupStatusOf(group.entries),
  }))
}

export function activityGroupLabel(kind: ActivityGroupKind, status: ToolStatus) {
  if (kind === 'exploration') {
    return status === 'running'
      ? '正在读取文件'
      : status === 'failed'
        ? '读取文件失败'
        : status === 'stopped'
          ? '读取文件未完成'
          : '已读取文件'
  }
  if (kind === 'file-changes') {
    return status === 'running'
      ? '正在编辑文件'
      : status === 'failed'
        ? '编辑文件失败'
        : status === 'stopped'
          ? '编辑文件未完成'
          : '编辑了文件'
  }
  if (kind === 'tools') {
    return status === 'running'
      ? '正在加载工具'
      : status === 'failed'
        ? '加载工具失败'
        : status === 'stopped'
          ? '加载工具未完成'
          : '加载了工具'
  }
  if (kind === 'dependencies') {
    return status === 'running'
      ? '正在处理依赖'
      : status === 'failed'
        ? '处理依赖失败'
        : status === 'stopped'
          ? '处理依赖未完成'
          : '处理了依赖'
  }
  return status === 'running'
    ? '正在调用工具'
    : status === 'failed'
      ? '工具调用失败'
      : status === 'stopped'
        ? '工具调用未完成'
        : '调用了工具'
}
