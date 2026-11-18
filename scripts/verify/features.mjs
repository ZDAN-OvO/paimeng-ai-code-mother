export const features = {
  generation: '注册登录、生成静态页、独立来源预览与刷新恢复',
  access: '跨账号权限、预览来源与无票据访问保护',
  steer: '运行中插话、刷新重新订阅与同一轮完成',
  cancellation: '停止生成、暂停队列并保留等待消息',
  recovery: '生成失败历史与继续队列后的新一轮成功',
}

export function featureFiles(name) {
  if (name === 'all') return []
  if (!Object.hasOwn(features, name))
    throw new Error(`未知功能 ${name}；可用：${Object.keys(features).join(', ')}, all`)
  return [`tests/e2e/${name}.spec.mjs`]
}
