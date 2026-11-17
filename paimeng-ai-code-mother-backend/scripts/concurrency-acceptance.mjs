#!/usr/bin/env node
/**
 * 真实后端并发验收：普通消息原子入队、同 id 幂等、冲突和取消暂停。
 * 本脚本只创建自己的账号和应用；首条消息会触发真实模型调用，随后立即取消。
 * 这里不等待 19 条真实运行依次消费，避免模型速度和供应商状态导致不稳定。
 */
const API = process.env.ACCEPTANCE_API ?? 'http://127.0.0.1:8123/api'
const MAIN = process.env.ACCEPTANCE_MAIN ?? 'http://paimeng.localhost:8090'
const REQUEST_TIMEOUT_MS = Number(process.env.ACCEPTANCE_REQUEST_TIMEOUT_MS ?? 15_000)
const QUEUE_WAIT_MS = Number(process.env.ACCEPTANCE_QUEUE_WAIT_MS ?? 20_000)

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  for (const cookie of cookies) if (cookie.startsWith('pm_sid=')) return cookie.split(';')[0]
  const raw = response.headers.get('set-cookie')
  return raw?.startsWith('pm_sid=') ? raw.split(';')[0] : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(read, accept, message, timeoutMs = QUEUE_WAIT_MS, intervalMs = 200) {
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
      return {
        ...queue,
        requestedItem: queue.items.find((item) => item.clientRequestId === clientRequestId),
      }
    },
    (queue) => Boolean(queue.activeRun) || queue.paused || queue.requestedItem?.status === 'returned',
    '首条普通消息没有开始运行或队列已暂停',
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

async function cancelUntilPaused(cookie, appId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await getQueue(cookie, appId)
    if (state.paused) return state
    if (state.activeRun) {
      await cancelRun(cookie, state.activeRun.runId)
      continue
    }
    await sleep(250)
  }
  const state = await getQueue(cookie, appId)
  assert(state.paused, '没有可取消的运行，但队列也未暂停')
  return state
}

async function cleanup(cookie, appIds) {
  for (const appId of appIds) {
    try {
      const state = await getQueue(cookie, appId)
      if (state.activeRun) await cancelRun(cookie, state.activeRun.runId)
    } catch {
      /* 清理只尽力执行，失败时保留原始验收错误 */
    }
    await request('/app/delete', { method: 'POST', cookie, body: { id: appId } }).catch(() => undefined)
  }
  await request('/user/logout', { method: 'POST', cookie }).catch(() => undefined)
}

async function run() {
  const account = `concurrency${Date.now()}`
  const password = 'password123'
  let cookie = null
  const appIds = []
  try {
    const registered = await request('/user/register', {
      method: 'POST',
      body: { userAccount: account, userPassword: password, checkPassword: password },
    })
    assert(registered.response.status < 300 && registered.json?.code === 0, '注册失败')
    cookie = sessionCookie(registered.response)
    assert(cookie, '缺少 session cookie')

    const created = await request('/app/add', {
      method: 'POST',
      cookie,
      body: { initPrompt: '并发队列验收应用' },
    })
    assert(created.json?.code === 0 && created.json.data?.id, '创建应用失败')
    const appId = created.json.data.id
    appIds.push(appId)

    const firstRequestId = crypto.randomUUID()
    const first = await enqueue(cookie, {
      appId,
      message: '开始一个持续较长的页面改造，用于并发队列验收',
      clientRequestId: firstRequestId,
      mode: 'normal',
    })
    assert(first.status === 'queued' && first.runId === null, '首条普通消息入队状态错误')
    const active = await waitForActiveRun(cookie, appId, firstRequestId)

    // 旧测试要求后 19 个请求直接 409/429；新语义要求它们都原子进入同一应用队列。
    const requests = Array.from({ length: 19 }, (_, index) => ({
      appId,
      message: `并发队列消息 ${index + 2}`,
      clientRequestId: crypto.randomUUID(),
      mode: 'normal',
    }))
    const accepted = await Promise.all(requests.map((body) => enqueue(cookie, body)))
    assert(accepted.length === 19, '并行入队响应数量不完整')
    assert(
      accepted.every((item) => item.status === 'queued' && item.runId === null),
      '并行普通消息没有全部按 queued 接受',
    )
    assert(new Set(accepted.map((item) => item.id)).size === accepted.length, '并行入队产生了重复队列项')

    const stableRequestId = crypto.randomUUID()
    const stablePayload = {
      appId,
      message: '同 clientRequestId 的幂等消息',
      clientRequestId: stableRequestId,
      mode: 'normal',
    }
    const deduplicated = await Promise.all(Array.from({ length: 20 }, () => enqueue(cookie, stablePayload)))
    assert(new Set(deduplicated.map((item) => item.id)).size === 1, '并发同 payload 没有收敛到同一队列项')

    const conflict = await request('/app/chat/queue', {
      method: 'POST',
      cookie,
      body: { ...stablePayload, message: '不同 payload' },
    })
    assert(
      conflict.response.status === 409 && conflict.json?.code === 40900,
      '同 id 不同 payload 应返回 40900',
    )

    const beforeCancel = await getQueue(cookie, appId)
    assert(beforeCancel.activeRun, '并发入队期间当前运行已经全部结束，无法验证取消暂停')
    assert(
      beforeCancel.items.some((item) => accepted.some((created) => created.id === item.id)),
      '并发接受的普通消息没有出现在队列状态中',
    )

    const paused = await cancelUntilPaused(cookie, appId)
    assert(paused.activeRun === null, '取消并收尾后 activeRun 不为空')
    const retained = paused.items.find(
      (item) => item.status === 'queued' && accepted.some((created) => created.id === item.id),
    )
    assert(retained?.status === 'queued', '取消后普通队列项没有保留')

    const removed = await request('/app/chat/queue/remove', {
      method: 'POST',
      cookie,
      body: { appId, id: retained.id },
    })
    assert(removed.response.status === 200 && removed.json?.code === 0, '移除排队消息失败')
    assert(!removed.json.data.items.some((item) => item.id === retained.id), '已移除队列项仍然可见')

    for (const item of removed.json.data.items) {
      const result = await request('/app/chat/queue/remove', {
        method: 'POST',
        cookie,
        body: { appId, id: item.id },
      })
      assert(result.response.status === 200 && result.json?.code === 0, `清理队列项 ${item.id} 失败`)
    }
    const resumed = await request('/app/chat/queue/resume', {
      method: 'POST',
      cookie,
      body: { appId },
    })
    assert(resumed.response.status === 200 && resumed.json?.code === 0, '继续队列失败')
    assert(
      resumed.json.data.paused === false &&
        resumed.json.data.activeRun === null &&
        resumed.json.data.items.length === 0,
      '清空队列后继续不应启动运行',
    )

    const deleted = await request('/app/delete', { method: 'POST', cookie, body: { id: appId } })
    assert(deleted.json?.code === 0, '删除应用失败')
    appIds.splice(appIds.indexOf(appId), 1)

    // 单用户并发上限仍由 PostgreSQL 约束：队列接受全部消息，但最多只有 5 个应用进入 activeRun。
    const limitApps = []
    for (let index = 0; index < 6; index += 1) {
      const result = await request('/app/add', {
        method: 'POST',
        cookie,
        body: { initPrompt: `单用户并发上限验收 ${index + 1}` },
      })
      assert(result.json?.code === 0 && result.json.data?.id, '创建并发上限测试应用失败')
      limitApps.push(result.json.data.id)
      appIds.push(result.json.data.id)
    }
    const limitItems = await Promise.all(
      limitApps.map((id, index) =>
        enqueue(cookie, {
          appId: id,
          message: `持续执行的多步骤页面改造 ${index + 1}`,
          clientRequestId: crypto.randomUUID(),
          mode: 'normal',
        }),
      ),
    )
    assert(
      limitItems.every((item) => item.status === 'queued'),
      '单用户并发上限下，队列入口不应直接拒绝普通消息',
    )
    await sleep(1000)
    const limitStates = await Promise.all(limitApps.map((id) => getQueue(cookie, id)))
    const activeLimitStates = limitStates.filter((state) => state.activeRun)
    assert(activeLimitStates.length <= 5, `单用户同时启动了 ${activeLimitStates.length} 个应用`)
    assert(
      limitStates.some(
        (state) =>
          !state.activeRun &&
          !state.paused &&
          state.items.some((item) => item.status === 'queued' || item.status === 'claimed'),
      ),
      '单用户并发达到上限后，超出的应用没有保留等待队列项',
    )
    await Promise.allSettled(activeLimitStates.map((state) => cancelRun(cookie, state.activeRun.runId)))

    console.log(
      '并发验收通过：19 条并行消息入队、同 id 幂等、不同 payload 409、取消暂停与移除、单用户最多 5 个应用运行',
    )
  } finally {
    if (cookie) await cleanup(cookie, appIds)
  }
}

run().catch((err) => {
  console.error(`并发验收失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
