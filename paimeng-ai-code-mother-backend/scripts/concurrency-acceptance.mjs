#!/usr/bin/env node
/**
 * 真实后端并发验收：同应用单 run、clientRequestId 防重、应用分钟限流。
 * 会产生少量真实模型调用；脚本会在断言后立即取消运行。
 */
const API = process.env.ACCEPTANCE_API ?? 'http://127.0.0.1:8123/api'
const MAIN = process.env.ACCEPTANCE_MAIN ?? 'http://paimeng.localhost:8090'

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
    /* SSE 或非 JSON */
  }
  return { response, json }
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? []
  for (const cookie of cookies) if (cookie.startsWith('pm_sid=')) return cookie.split(';')[0]
  const raw = response.headers.get('set-cookie')
  return raw?.startsWith('pm_sid=') ? raw.split(';')[0] : null
}

async function createSession() {
  const account = `concurrency${Date.now()}`
  const password = 'password123'
  const registered = await request('/user/register', {
    method: 'POST',
    body: { userAccount: account, userPassword: password, checkPassword: password },
  })
  assert(registered.response.status < 300 && registered.json?.code === 0, '注册失败')
  const cookie = sessionCookie(registered.response)
  assert(cookie, '缺少 session cookie')
  return cookie
}

async function createApp(cookie) {
  const created = await request('/app/add', {
    method: 'POST',
    cookie,
    body: { initPrompt: '并发验收应用' },
  })
  assert(created.json?.code === 0 && created.json.data?.id, '创建应用失败')
  return created.json.data.id
}

async function openChat(cookie, appId, clientRequestId, message) {
  const response = await fetch(`${API}/app/chat/gen/code`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Origin: MAIN,
      Cookie: cookie,
    },
    body: JSON.stringify({ appId, clientRequestId, message }),
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* ignore */
    }
    return { status: response.status, code: json?.code ?? null, runId: null, reader: null }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let runId = null
  while (!runId) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const chunk = JSON.parse(line.slice(5).trim())
          if (chunk.data?.runId) runId = chunk.data.runId
        } catch {
          /* ignore */
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
  return { status: response.status, code: null, runId, reader }
}

async function cancelAndWait(cookie, runId, reader) {
  if (runId) {
    await request('/app/run/cancel', { method: 'POST', cookie, body: { runId } }).catch(() => undefined)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const status = await request(`/app/run/status?runId=${runId}`, { cookie }).catch(() => null)
      const value = status?.json?.data?.status
      if (value && value !== 'running' && value !== 'cancelling') break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  await reader?.cancel().catch(() => undefined)
}

async function run() {
  const cookie = await createSession()

  // 同应用并发不同请求：最多一个 run，其余 409/429。
  const appId = await createApp(cookie)
  const first = await openChat(cookie, appId, crypto.randomUUID(), '并发测试：创建一个待办页面')
  assert(first.runId, '首个请求没有启动 run')
  const deleteConflict = await request('/app/delete', {
    method: 'POST',
    cookie,
    body: { id: appId },
  })
  assert(deleteConflict.response.status === 409, '运行中删除应用应返回 409')
  const others = await Promise.all(
    Array.from({ length: 19 }, (_, index) =>
      openChat(cookie, appId, crypto.randomUUID(), `并发测试请求 ${index + 2}`),
    ),
  )
  const runIds = new Set([first.runId, ...others.map((item) => item.runId).filter(Boolean)])
  assert(runIds.size === 1, `同应用并发出现了 ${runIds.size} 个 run`)
  assert(others.some((item) => item.status === 409 || item.status === 429), '并发请求没有返回 409/429')
  assert(others.some((item) => item.status === 429), '并发请求没有触发应用限流')
  await cancelAndWait(cookie, first.runId, first.reader)
  await Promise.all(others.map((item) => item.reader?.cancel().catch(() => undefined)))

  // clientRequestId 防重：所有成功响应必须指向同一个 run。
  const dedupApp = await createApp(cookie)
  const requestId = crypto.randomUUID()
  const dedupFirst = await openChat(cookie, dedupApp, requestId, '防重测试：创建一个页面')
  assert(dedupFirst.runId, '防重首个请求没有启动 run')
  const duplicates = await Promise.all(
    Array.from({ length: 19 }, () => openChat(cookie, dedupApp, requestId, '防重测试：创建一个页面')),
  )
  const dedupRunIds = new Set([
    dedupFirst.runId,
    ...duplicates.map((item) => item.runId).filter(Boolean),
  ])
  assert(dedupRunIds.size === 1, `clientRequestId 防重出现了 ${dedupRunIds.size} 个 run`)
  const byClientRequest = await request(
    `/app/run/status?appId=${dedupApp}&clientRequestId=${encodeURIComponent(requestId)}`,
    { cookie },
  )
  assert(
    byClientRequest.json?.data?.runId === dedupFirst.runId,
    '首次 SSE 事件丢失后无法按 appId + clientRequestId 查询原 run',
  )
  await cancelAndWait(cookie, dedupFirst.runId, dedupFirst.reader)
  await Promise.all(duplicates.map((item) => item.reader?.cancel().catch(() => undefined)))

  // 单用户 6 个应用同时申请：最多接受 5 个。
  const appIds = []
  for (let index = 0; index < 6; index += 1) appIds.push(await createApp(cookie))
  const userRuns = await Promise.all(
    appIds.map((id, index) =>
      openChat(cookie, id, crypto.randomUUID(), `用户并发上限测试 ${index + 1}`),
    ),
  )
  const accepted = userRuns.filter((item) => item.runId)
  const rejected = userRuns.filter((item) => item.status === 409)
  assert(accepted.length <= 5, `单用户同时接受了 ${accepted.length} 个运行`)
  assert(rejected.length >= 1, '单用户第 6 个应用没有被拒绝')
  await Promise.all(
    userRuns.map((item) => cancelAndWait(cookie, item.runId, item.reader)),
  )

  console.log('并发验收通过：单 run、防重、限流、单用户 5 应用上限')
}

run().catch((err) => {
  console.error(`并发验收失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
