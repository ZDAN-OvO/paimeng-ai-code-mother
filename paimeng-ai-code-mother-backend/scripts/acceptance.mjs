#!/usr/bin/env node
/**
 * 黑盒验收脚本：要求后端、Nginx、PostgreSQL、Redis 已启动。
 * 队列验收会启动少量真实运行并尽快取消；不等待批量模型消费。
 */
const API = process.env.ACCEPTANCE_API ?? 'http://127.0.0.1:8123/api'
const MAIN = process.env.ACCEPTANCE_MAIN ?? 'http://paimeng.localhost:8090'
const PREVIEW_PORT = process.env.ACCEPTANCE_PREVIEW_PORT ?? '8090'
const REQUEST_TIMEOUT_MS = Number(process.env.ACCEPTANCE_REQUEST_TIMEOUT_MS ?? 15_000)
const QUEUE_WAIT_MS = Number(process.env.ACCEPTANCE_QUEUE_WAIT_MS ?? 20_000)
const cleanupState = { cookie: null, appIds: new Set() }

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
  if (options.method && options.method !== 'GET') {
    const origin = options.origin === undefined ? MAIN : options.origin
    if (origin) headers.Origin = origin
  }
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(read, accept, message, timeoutMs = QUEUE_WAIT_MS, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    await sleep(intervalMs)
  }
  throw new Error(`${message}；最后状态：${JSON.stringify(last)}`)
}

async function getQueue(cookie, appId) {
  const result = await request(`/app/chat/queue?appId=${appId}`, { cookie })
  assert(result.response.status === 200 && result.json?.code === 0, '读取消息队列失败')
  return result.json.data
}

async function enqueue(cookie, body) {
  const result = await request('/app/chat/queue', { method: 'POST', cookie, body })
  assert(result.response.status === 200 && result.json?.code === 0, `加入消息队列失败：${result.text}`)
  return result.json.data
}

async function waitForActiveRun(cookie, appId, clientRequestId) {
  const state = await waitFor(
    async () => {
      const queue = await getQueue(cookie, appId)
      return { ...queue, item: queue.items.find((item) => item.clientRequestId === clientRequestId) }
    },
    (queue) => Boolean(queue.activeRun) || queue.paused || queue.item?.status === 'returned',
    '普通消息没有开始运行或队列已暂停',
  )
  assert(state.activeRun, `队列未能开始首条普通消息：${JSON.stringify(state)}`)
  return state.activeRun
}

async function waitForRunTerminal(cookie, runId) {
  return waitFor(
    async () => {
      const result = await request(`/app/run/status?runId=${encodeURIComponent(runId)}`, { cookie })
      assert(result.response.status === 200 && result.json?.code === 0, '查询运行状态失败')
      return result.json.data
    },
    (run) => ['completed', 'failed', 'cancelled'].includes(run.status),
    `运行 ${runId} 未在限定时间内结束`,
  )
}

async function cancelRun(cookie, runId) {
  const result = await request('/app/run/cancel', { method: 'POST', cookie, body: { runId } })
  assert(result.response.status === 200 && result.json?.code === 0, '取消运行失败')
  return waitForRunTerminal(cookie, runId)
}

async function disconnectRunStream(cookie, runId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetch(`${API}/app/run/stream`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Origin: MAIN,
        Cookie: cookie,
      },
      body: JSON.stringify({ runId }),
      signal: controller.signal,
    })
    assert(response.ok, `订阅运行流失败：HTTP ${response.status}`)
    assert((response.headers.get('content-type') ?? '').includes('text/event-stream'), '运行流不是 SSE')
    assert(response.body, '运行流没有响应体')
    await response.body.getReader().cancel()
  } finally {
    clearTimeout(timeout)
  }
}

async function cleanup() {
  if (!cleanupState.cookie) return
  for (const appId of cleanupState.appIds) {
    try {
      const state = await getQueue(cleanupState.cookie, appId)
      if (state.activeRun) await cancelRun(cleanupState.cookie, state.activeRun.runId)
    } catch {
      /* 清理只尽力执行，失败时保留原始验收错误 */
    }
    await request('/app/delete', {
      method: 'POST',
      cookie: cleanupState.cookie,
      body: { id: appId },
    }).catch(() => undefined)
  }
  await request('/user/logout', { method: 'POST', cookie: cleanupState.cookie }).catch(() => undefined)
}

async function runAcceptance() {
  const account = `acceptance${Date.now()}`
  const password = 'password123'
  const registered = await request('/user/register', {
    method: 'POST',
    body: { userAccount: account, userPassword: password, checkPassword: password },
  })
  assert(registered.response.status < 300 && registered.json?.code === 0, '注册失败')
  const cookie = sessionCookie(registered.response)
  assert(cookie, '注册后没有 session cookie')
  cleanupState.cookie = cookie

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
  cleanupState.appIds.add(appId)

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
  assert(
    listed.json?.data?.records?.some((item) => item.id === appId),
    '应用列表缺少新应用',
  )
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
  const missingRun = await request('/app/run/status?runId=00000000-0000-4000-8000-000000000000', { cookie })
  assert(missingRun.response.status === 404 && missingRun.json?.code === 40400, '不存在运行应返回 40400')

  const queueAppResult = await request('/app/add', {
    method: 'POST',
    cookie,
    body: { initPrompt: '验收脚本创建的队列测试页面' },
  })
  assert(queueAppResult.json?.code === 0 && queueAppResult.json.data?.id > 0, '创建队列测试应用失败')
  const queueAppId = queueAppResult.json.data.id
  cleanupState.appIds.add(queueAppId)

  const emptyQueue = await getQueue(cookie, queueAppId)
  assert(
    emptyQueue.paused === false && emptyQueue.items.length === 0 && emptyQueue.activeRun === null,
    '新应用队列应为空且未暂停',
  )
  const forbiddenQueue = await request(`/app/chat/queue?appId=${queueAppId}`, { cookie: otherCookie })
  assert(forbiddenQueue.response.status === 403, '跨账号读取队列应返回 403')
  const forbiddenEnqueue = await request('/app/chat/queue', {
    method: 'POST',
    cookie: otherCookie,
    body: {
      appId: queueAppId,
      message: '越权消息',
      clientRequestId: crypto.randomUUID(),
      mode: 'normal',
    },
  })
  assert(forbiddenEnqueue.response.status === 403, '跨账号写入队列应返回 403')
  const wrongOrigin = await request('/app/chat/queue', {
    method: 'POST',
    cookie,
    origin: 'https://untrusted.example',
    body: {
      appId: queueAppId,
      message: '错误 Origin 消息',
      clientRequestId: crypto.randomUUID(),
      mode: 'normal',
    },
  })
  assert(wrongOrigin.response.status === 403, '非白名单 Origin 写入队列应返回 403')

  const firstText = '开始一个需要持续执行的多步骤页面改造，用于验证运行流断开后任务仍继续'
  const firstItem = await enqueue(cookie, {
    appId: queueAppId,
    message: firstText,
    clientRequestId: crypto.randomUUID(),
    mode: 'normal',
  })
  assert(firstItem.status === 'queued' && firstItem.runId === null, '普通消息入队状态错误')

  const queuedText = '这条普通消息应只存在于队列，取消后保留并可移除'
  const queuedRequestId = crypto.randomUUID()
  const queuedItem = await enqueue(cookie, {
    appId: queueAppId,
    message: queuedText,
    clientRequestId: queuedRequestId,
    mode: 'normal',
  })
  const duplicate = await enqueue(cookie, {
    appId: queueAppId,
    message: queuedText,
    clientRequestId: queuedRequestId,
    mode: 'normal',
  })
  assert(duplicate.id === queuedItem.id, '相同 clientRequestId 和 payload 应复用同一队列项')
  const conflict = await request('/app/chat/queue', {
    method: 'POST',
    cookie,
    body: {
      appId: queueAppId,
      message: `${queuedText}（不同内容）`,
      clientRequestId: queuedRequestId,
      mode: 'normal',
    },
  })
  assert(conflict.response.status === 409 && conflict.json?.code === 40900, '同 id 不同 payload 应返回 40900')

  const firstActive = await waitForActiveRun(cookie, queueAppId, firstItem.clientRequestId)
  const firstRunId = firstActive.runId
  const startedLookup = await waitFor(
    () => request(`/app/chat/queue?appId=${queueAppId}&clientRequestId=${firstItem.clientRequestId}`, { cookie }),
    (result) => result.json?.data?.requestedItem?.status === 'started',
    '运行开始后队列项没有完成启动确认',
  )
  assert(
    startedLookup.response.status === 200 &&
      startedLookup.json?.data?.requestedItem?.status === 'started' &&
      startedLookup.json.data.requestedItem.runId === firstRunId,
    '已启动消息应可按请求 ID 查询到对应运行',
  )
  await disconnectRunStream(cookie, firstRunId)
  const afterDisconnect = await request(`/app/run/status?runId=${firstRunId}`, { cookie })
  assert(afterDisconnect.response.status === 200 && afterDisconnect.json?.code === 0, '断流后查询运行失败')
  assert(
    ['running', 'completed', 'failed'].includes(afterDisconnect.json.data.status),
    `运行流断开不应取消运行，实际状态为 ${afterDisconnect.json.data.status}`,
  )

  const activeQueue = await getQueue(cookie, queueAppId)
  assert(activeQueue.activeRun?.runId === firstRunId, '队列当前运行与首条消息不匹配')
  assert(
    activeQueue.items.some((item) => item.id === queuedItem.id && item.status === 'queued'),
    '等待中的普通消息没有保留在队列',
  )
  const queueHistory = await request(`/chatHistory/app/${queueAppId}?pageSize=50`, { cookie })
  assert(queueHistory.response.status === 200, '读取队列应用历史失败')
  const queueHistoryText = JSON.stringify(queueHistory.json?.data?.records ?? [])
  assert(queueHistoryText.includes(firstText), '已开始运行的用户消息没有进入历史')
  assert(!queueHistoryText.includes(queuedText), '等待中的队列消息不应进入对话历史')

  await cancelRun(cookie, firstRunId)
  const paused = await waitFor(
    () => getQueue(cookie, queueAppId),
    (state) => state.paused,
    '取消运行后队列没有暂停',
  )
  assert(paused.activeRun === null, '取消运行收尾后队列仍显示 activeRun')
  const retained = paused.items.find((item) => item.id === queuedItem.id)
  assert(retained?.status === 'queued', '取消后等待中的普通消息没有保留')

  const removed = await request('/app/chat/queue/remove', {
    method: 'POST',
    cookie,
    body: { appId: queueAppId, id: retained.id },
  })
  assert(removed.response.status === 200 && removed.json?.code === 0, '移除队列消息失败')
  assert(!removed.json.data.items.some((item) => item.id === retained.id), '已移除的队列项仍然可见')
  const itemQuery = `/app/chat/queue?appId=${queueAppId}&clientRequestId=${queuedRequestId}`
  const removedLookup = await request(itemQuery, { cookie })
  assert(
    removedLookup.response.status === 200 &&
      removedLookup.json?.data?.requestedItem?.status === 'removed' &&
      removedLookup.json.data.requestedItem.id === retained.id,
    '按请求 ID 查询应返回已经移除的消息标记',
  )
  const forbiddenLookup = await request(itemQuery, { cookie: otherCookie })
  assert(forbiddenLookup.response.status === 403, '跨账号查询单条队列消息应返回 403')
  const resumed = await request('/app/chat/queue/resume', {
    method: 'POST',
    cookie,
    body: { appId: queueAppId },
  })
  assert(resumed.response.status === 200 && resumed.json?.code === 0, '继续空队列失败')
  assert(
    resumed.json.data.paused === false &&
      resumed.json.data.activeRun === null &&
      resumed.json.data.items.length === 0,
    '移除唯一待发送项后继续队列不应启动运行',
  )
  await cancelRun(cookie, firstRunId)
  assert(!(await getQueue(cookie, queueAppId)).paused, '重复取消终态运行不能再次暂停已恢复的队列')

  const queueDeleted = await request('/app/delete', {
    method: 'POST',
    cookie,
    body: { id: queueAppId },
  })
  assert(queueDeleted.json?.code === 0, '删除队列测试应用失败')
  cleanupState.appIds.delete(queueAppId)

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
  cleanupState.appIds.delete(appId)
  await sleep(1000)
  const gone = await request(`/app/get/vo?id=${appId}`, { cookie })
  assert(gone.response.status === 404, '删除后应用仍可访问')

  const loggedOut = await request('/user/logout', { method: 'POST', cookie })
  assert(loggedOut.json?.code === 0, '退出登录失败')
  const afterLogout = await request('/user/get/login', { cookie })
  assert(afterLogout.response.status === 401, '退出后仍保持登录态')
  cleanupState.cookie = null

  console.log(`验收通过：账号 ${account}，应用 ${appId}，队列应用 ${queueAppId}`)
}

async function main() {
  try {
    await runAcceptance()
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(`验收失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
