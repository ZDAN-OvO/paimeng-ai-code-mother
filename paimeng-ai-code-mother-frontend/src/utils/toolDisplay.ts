import type { ToolStatus } from './agentActivity'

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function dependencyText(input?: Record<string, unknown>) {
  const action = text(input?.action)
  const names = Array.isArray(input?.packages)
    ? input.packages
        .map((item) => (item && typeof item === 'object' ? text((item as Record<string, unknown>).name) : ''))
        .filter(Boolean)
    : Array.isArray(input?.names)
      ? input.names.map(String)
      : []
  if (action === 'add') return names.length ? names.join('、') : '依赖'
  if (action === 'remove') return names.length ? names.join('、') : '依赖'
  if (action === 'list_allowed') return '允许依赖'
  if (action === 'list_installed') return '已安装依赖'
  return '依赖'
}

export function describeTool(
  tool: string,
  input: Record<string, unknown> | undefined,
  status: ToolStatus,
  result?: Record<string, unknown>,
  error?: string,
) {
  const path = text(input?.path) || text(result?.path)
  const pattern = text(input?.pattern)
  const name = text(input?.name)
  let verb = '执行'
  let object = ''
  if (tool === 'read') {
    verb = '读取'
    object = path || '文件'
  } else if (tool === 'write') {
    verb = result?.created === true ? '创建' : '写入'
    object = path || '文件'
  } else if (tool === 'edit') {
    verb = '编辑'
    object = path || '文件'
  } else if (tool === 'delete') {
    verb = '删除'
    object = path || '文件'
  } else if (tool === 'ls') {
    verb = '查看'
    object = path || '项目目录'
  } else if (tool === 'grep') {
    verb = '搜索'
    object = pattern ? `“${pattern}”` : '项目内容'
  } else if (tool === 'find') {
    verb = '查找'
    object = pattern ? `“${pattern}”` : '文件'
  } else if (tool === 'load_skill') {
    verb = '加载'
    object = name ? `${name} 技能` : '技能'
  } else if (tool === 'read_skill_resource') {
    verb = '读取'
    object = path || '技能资源'
  } else if (tool === 'dependencies') {
    const action = text(input?.action)
    verb =
      action === 'add' ? '添加' : action === 'remove' ? '移除' : action === 'sync' ? '同步' : '查看'
    object = dependencyText(input)
  } else if (tool === 'preview') {
    object = '预览'
  }
  const phrase = /^[A-Za-z0-9_./@-]/.test(object) || object.startsWith('“') ? `${verb} ${object}` : `${verb}${object}`
  if (status === 'running') return `正在${phrase}`
  if (status === 'failed') return `未能${phrase}${error ? `：${error}` : ''}`
  if (status === 'stopped') return `${phrase}未完成`
  return `已${phrase}`
}
