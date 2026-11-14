#!/usr/bin/env node
/**
 * 黑盒验收脚本：要求后端、Nginx、PostgreSQL、Redis 已启动。
 * 只覆盖不依赖模型生成的 API 不变量；真实模型四轮验收见 docs/acceptance.md。
 */
const API = process.env.ACCEPTANCE_API ?? 'http://127.0.0.1:8123/api'
const MAIN = process.env.ACCEPTANCE_MAIN ?? 'http://paimeng.localhost:8090'
const PREVIEW_PORT = process.env.ACCEPTANCE_PREVIEW_PORT ?? '8090'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function request(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.headers ?? {}),
  }
  if (options.method && options.method !== 'GET') headers.Origin = MAIN
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应由调用方断言状态码 */
  }
  return { response, json, text }
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? []
  for (const cookie of cookies) {
    if (cookie.startsWith('pm_sid=')) return cookie.split(';')[0]
  }
  const raw = response.headers.get('set-cookie')
  return raw?.startsWith('pm_sid=') ? raw.split(';')[0] : null
}

async function main() {
  const account = `acceptance${Date.now()}`
  const password = 'password123'

  const registered = await request('/user/register', {
    method: 'POST',
    body: { userAccount: account, userPassword: password, checkPassword: password },
  })
  assert(registered.response.status < 300 && registered.json?.code === 0, '注册失败')
  const cookie = sessionCookie(registered.response)
  assert(cookie, '注册后没有 session cookie')

  const anonymous = await request('/user/get/login')
  assert(anonymous.response.status === 401 && anonymous.json?.code === 40100, '未登录访问应返回 40100')

  const login = await request('/user/get/login', { cookie })
  assert(login.json?.data?.userAccount === account, '登录态用户不匹配')

  const created = await request('/app/add', {
    method: 'POST',
    cookie,
    body: { initPrompt: '验收脚本创建的静态待办页面' },
  })
  assert(created.json?.code === 0 && created.json.data?.id > 0, '创建应用失败')
  const appId = created.json.data.id

  const app = await request(`/app/get/vo?id=${appId}`, { cookie })
  assert(app.json?.data?.id === appId, '应用详情不匹配')
  assert(app.json.data.currentRun === null, '新应用不应有运行记录')
  assert(app.json.data.preview?.status === 'stopped', '空应用预览应为 stopped')

  const otherAccount = `acceptance-other${Date.now()}`
  const otherRegistered = await request('/user/register', {
    method: 'POST',
    body: { userAccount: otherAccount, userPassword: password, checkPassword: password },
  })
  const otherCookie = sessionCookie(otherRegistered.response)
  assert(otherCookie, '第二个用户注册后没有 session cookie')
  const forbidden = await request(`/app/get/vo?id=${appId}`, { cookie: otherCookie })
  assert(forbidden.response.status === 403 && forbidden.json?.code === 40300, '越权读取应用应返回 40300')
  const forbiddenHistory = await request(`/chatHistory/app/${appId}`, { cookie: otherCookie })
  assert(forbiddenHistory.response.status === 403, '越权读取历史应返回 403')

  const listed = await request('/app/my/list/page/vo', {
    method: 'POST',
    cookie,
    body: { pageNum: 1, pageSize: 20, sortField: 'createTime', sortOrder: 'desc' },
  })
  assert(listed.json?.data?.records?.some((item) => item.id === appId), '应用列表缺少新应用')

  const renamed = await request('/app/update', {
    method: 'POST',
    cookie,
    body: { id: appId, appName: '验收应用已改名' },
  })
  assert(renamed.json?.code === 0, '应用改名失败')
  const afterRename = await request(`/app/get/vo?id=${appId}`, { cookie })
  assert(afterRename.json?.data?.appName === '验收应用已改名', '应用改名未生效')

  const history = await request(`/chatHistory/app/${appId}?pageSize=20`, { cookie })
  assert(Array.isArray(history.json?.data?.records), '历史消息结构错误')
  assert(history.json.data.records.length === 0, '新应用历史应为空')

  const missingRun = await request(
    '/app/run/status?runId=00000000-0000-4000-8000-000000000000',
    { cookie },
  )
  assert(missingRun.response.status === 404 && missingRun.json?.code === 40400, '不存在运行应返回 40400')

  const ticket = await request('/app/preview/access', {
    method: 'POST',
    cookie,
    body: { appId },
  })
  assert(ticket.json?.code === 0 && ticket.json.data?.ticket?.ticket, '预览票据签发失败')
  const previewUrl = `http://app-${appId}.preview.paimeng.localhost:${PREVIEW_PORT}`
  const unauthorizedPreview = await fetch(`${previewUrl}/`, { redirect: 'manual' })
  assert(unauthorizedPreview.status === 401, '未授权预览应返回 401')
  const access = await fetch(`${previewUrl}/__platform/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: ticket.json.data.ticket.ticket }),
    redirect: 'manual',
  })
  assert(access.status === 204, '预览票据 POST 应返回 204')
  const reusedAccess = await fetch(`${previewUrl}/__platform/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: ticket.json.data.ticket.ticket }),
    redirect: 'manual',
  })
  assert(reusedAccess.status === 403, '预览票据重复使用应返回 403')

  const deleted = await request('/app/delete', { method: 'POST', cookie, body: { id: appId } })
  assert(deleted.json?.code === 0, '删除应用失败')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const gone = await request(`/app/get/vo?id=${appId}`, { cookie })
  assert(gone.response.status === 404, '删除后应用仍可访问')

  const loggedOut = await request('/user/logout', { method: 'POST', cookie })
  assert(loggedOut.json?.code === 0, '退出登录失败')
  const afterLogout = await request('/user/get/login', { cookie })
  assert(afterLogout.response.status === 401, '退出后仍保持登录态')

  console.log(`验收通过：账号 ${account}，应用 ${appId}`)
}

main().catch((err) => {
  console.error(`验收失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
