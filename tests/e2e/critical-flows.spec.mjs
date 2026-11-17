import { test as base, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { browserEnvironment } from './environment.mjs'

const env = browserEnvironment()
const password = 'BrowserFlow-password-2026'
const draftPlaceholder = '描述你想做的页面，或继续提出修改…'
const test = base.extend({
  model: async ({}, use) => {
    const markers = []
    await use({
      async create(mode = 'normal') {
        const marker = `e2e-${randomUUID().replaceAll('-', '')}`
        const steer = `插话-${marker.slice(4, 16)}`
        const created = await control('/__control/scenarios', 'POST', { marker, mode, steer })
        markers.push(marker)
        return {
          marker, steer, partial: created.partial, prompt: `创建一个静态页面，页面标记为 ${marker}`,
          stats: () => control(`/__control/scenarios/${marker}`),
          release: () => control(`/__control/scenarios/${marker}/release`, 'POST'),
        }
      },
    })
    for (const marker of markers) await control(`/__control/scenarios/${marker}`, 'DELETE')
  },
})

async function control(path, method = 'GET', data) {
  const response = await fetch(`${env.modelOrigin}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(3_000),
  })
  expect(response.ok, `模型 fixture ${method} ${path}`).toBeTruthy()
  return response.json()
}

// 业务 API 请求仍由浏览器发到真实后端；没有 page.route 或业务 HTTP 替身。
async function api(page, path, method = 'GET', data) {
  return page.evaluate(async ({ path, method, data }) => {
    const response = await fetch(`/api${path}`, {
      method, credentials: 'include', headers: { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, body: await response.json() }
  }, { path, method, data })
}

async function dataOf(page, path) {
  const result = await api(page, path)
  expect(result.status).toBe(200)
  expect(result.body.code).toBe(0)
  return result.body.data
}

// 原生 HTTP 明确保留 Host，Node fetch 的 Host 处理不能用于证明预览来源保护。
async function hostRequest(path, headers, data) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${env.probeOrigin}${path}`, {
      method: data === undefined ? 'GET' : 'POST', headers,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (part) => { body += part })
      response.on('end', () => resolve({ status: response.statusCode, body }))
      response.on('error', reject)
    })
    const timer = setTimeout(() => request.destroy(new Error('Host API request timed out')), 5_000)
    request.on('error', reject)
    request.on('close', () => clearTimeout(timer))
    request.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

async function registerAndLogin(page) {
  const userAccount = `browser_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await page.goto('/user/register')
  await page.getByPlaceholder('请输入账号', { exact: true }).fill(userAccount)
  await page.getByPlaceholder('请输入密码', { exact: true }).fill(password)
  await page.getByPlaceholder('请确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^注\s*册$/ }).click()
  await expect(page).toHaveURL(/\/user\/login$/)
  await page.getByPlaceholder('请输入账号', { exact: true }).fill(userAccount)
  await page.getByPlaceholder('请输入密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^登\s*录$/ }).click()
  await expect(page.getByRole('heading', { name: '把一句话，变成能用的应用' })).toBeVisible()
}

function queueResponse(page) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/app/chat/queue' && response.request().method() === 'POST')
}

async function createApp(page, scenario) {
  await page.getByPlaceholder('例如：做一个可以添加、勾选和删除任务的待办清单，中文界面').fill(scenario.prompt)
  const [response] = await Promise.all([
    queueResponse(page), page.getByRole('button', { name: '开始创建' }).click(),
  ])
  await expect(page).toHaveURL(/\/app\/chat\/\d+(?:\?.*)?$/)
  const result = await response.json()
  expect(response.status()).toBe(200)
  expect(result.code).toBe(0)
  return { appId: Number(new URL(page.url()).pathname.split('/').at(-1)), item: result.data }
}

async function send(page, message, mode) {
  if (mode) await page.getByRole('group', { name: '发送模式' }).getByRole('button', { name: mode, exact: true }).click()
  await page.getByPlaceholder(draftPlaceholder).fill(message)
  const [response] = await Promise.all([
    queueResponse(page), page.getByRole('button', { name: '发送消息', exact: true }).click(),
  ])
  const result = await response.json()
  expect(response.status()).toBe(200)
  expect(result.code).toBe(0)
  await expect(page.getByPlaceholder(draftPlaceholder)).toHaveValue('')
  return result.data
}

async function readRun(page, appId, item) {
  const result = await api(page, `/app/run/status?appId=${appId}&clientRequestId=${item.clientRequestId}`)
  // 派发前允许暂时没有运行记录；其他错误必须暴露。
  if (result.status === 404) return null
  expect(result.status).toBe(200)
  expect(result.body.code).toBe(0)
  return result.body.data
}

async function waitRun(page, appId, item, status) {
  await expect.poll(async () => (await readRun(page, appId, item))?.status, {
    message: `运行必须进入 ${status}`, timeout: 12_000,
  }).toBe(status)
  return readRun(page, appId, item)
}

function preview(page) { return page.frameLocator('iframe[title="应用预览"]') }

async function expectCompleted(page, scenario, suffix = '') {
  await expect(page.getByText(`页面已完成 ${scenario.marker}${suffix}`, { exact: true })).toBeVisible()
  await expect(preview(page).getByRole('heading', { name: scenario.marker, exact: true })).toBeVisible()
  await expect(page.getByText('预览运行中', { exact: true })).toBeVisible()
  const stats = await scenario.stats()
  expect(stats.calls).toEqual(['update_plan', 'write'])
}

test('注册登录、生成静态页、刷新恢复，并拒绝跨账号与预览来源访问', async ({ page, browser, model }) => {
  const scenario = await model.create()
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const run = await waitRun(page, appId, item, 'completed')
  await expectCompleted(page, scenario)
  const frameUrl = await page.getByTitle('应用预览', { exact: true }).getAttribute('src')
  expect(new URL(frameUrl).hostname).toBe(`app-${appId}.${env.previewDomain}`)
  expect(new URL(frameUrl).origin).not.toBe(env.mainOrigin)
  await page.reload()
  await expectCompleted(page, scenario)
  await expect(page.getByText(scenario.prompt, { exact: true })).toBeVisible()
  expect((await scenario.stats()).requests).toBe(3)

  const outsider = await browser.newContext()
  try {
    const otherPage = await outsider.newPage()
    await otherPage.goto(`${env.mainOrigin}/user/login`)
    const registered = await api(otherPage, '/user/register', 'POST', {
      userAccount: `other_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      userPassword: password, checkPassword: password,
    })
    expect(registered.body.code).toBe(0)
    for (const path of [
      `/app/get/vo?id=${appId}`, `/chatHistory/app/${appId}`,
      `/app/chat/queue?appId=${appId}`, `/app/run/status?runId=${run.runId}`,
    ]) {
      const denied = await api(otherPage, path)
      expect(denied.status, path).toBe(403)
      expect(denied.body).toMatchObject({ code: 40300, data: null })
    }
    const access = await api(otherPage, '/app/preview/access', 'POST', { appId })
    expect(access.status).toBe(403)
    expect(access.body.code).toBe(40300)
  } finally { await outsider.close() }

  // API 补充：携带真实用户 cookie，模拟预览来源的写请求。浏览器禁止手工覆盖 Origin。
  const cookies = await page.context().cookies(env.mainOrigin)
  const session = cookies.find((cookie) => cookie.name === 'pm_sid')
  expect(session).toBeTruthy()
  const forbidden = await hostRequest('/api/app/update', {
      Host: new URL(env.mainOrigin).host, Origin: new URL(frameUrl).origin,
      Cookie: `pm_sid=${session.value}`, 'content-type': 'application/json',
    }, { id: appId, appName: '不应修改' })
  expect(forbidden.status).toBe(403)
  expect(JSON.parse(forbidden.body)).toMatchObject({ code: 40300, data: null })
  const unauthenticated = await hostRequest('/', { Host: new URL(frameUrl).host, Accept: 'application/json' })
  expect(unauthenticated.status).toBe(401)
})

test('运行中插话经真实队列消费，刷新后重新订阅并完成同一轮', async ({ page, model }) => {
  const scenario = await model.create('hold')
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const run = await waitRun(page, appId, item, 'running')
  await expect.poll(async () => (await scenario.stats()).waiting).toBe(true)
  // 这段文本只在模型流里，从不落库：看得见就证明 SSE 真的在推流，而不是靠轮询回填终态。
  await expect(page.getByText(scenario.partial, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
  const steer = await send(page, scenario.steer, '插话发送')
  expect(steer).toMatchObject({ mode: 'steer', runId: run.runId })
  await expect(page.getByText('插话发送 · 等待插入当前轮次', { exact: true })).toBeVisible()
  // reload 真正断开浏览器 SSE；模型请求仍被闸门持有，不能凭固定 sleep 猜时机。
  const [subscription] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/app/run/stream' && response.request().method() === 'POST'),
    page.reload(),
  ])
  // 重连必须是对同一运行的真实订阅：状态码、流式类型、runId 三者都要对。
  expect(subscription.status()).toBe(200)
  expect(subscription.headers()['content-type']).toContain('text/event-stream')
  expect(subscription.request().postDataJSON()).toMatchObject({ runId: run.runId })
  // 界面能看到不够：历史接口也能返回已落库的文本。真正要证的是这条订阅收到了帧。
  await expect(page.getByText(scenario.partial, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
  await expect(page.getByText('插话发送 · 等待插入当前轮次', { exact: true })).toBeVisible()
  expect((await readRun(page, appId, item)).runId).toBe(run.runId)
  await scenario.release()
  const completed = await waitRun(page, appId, item, 'completed')
  expect(completed.runId).toBe(run.runId)
  await expectCompleted(page, scenario, `；已应用插话：${scenario.steer}`)
  await expect(page.getByText('插入指令', { exact: true })).toBeVisible()
  await expect(page.getByText(scenario.steer, { exact: true })).toBeVisible()
  await expect(preview(page).getByText(`页面已生成；已应用插话：${scenario.steer}`, { exact: true })).toBeVisible()
  // 直接读这条订阅的响应体：历史重放会带出已落库文本，只有真实推送才带得出 text-delta 帧。
  // text/event-stream 不带 charset，Playwright 取回的文本里中文已是乱码，
  // 所以只比对这条流里的 ASCII 标记：中间文本一定在 text-delta 帧里，且只由这条订阅送出。
  const frames = Buffer.from(await subscription.body()).toString('latin1')
  expect(frames).toContain('"type":"text-delta"')
  expect(frames).toMatch(new RegExp(`"type":"text-delta"[^\\n]*${scenario.marker}`))
  const queue = await dataOf(page, `/app/chat/queue?appId=${appId}&clientRequestId=${steer.clientRequestId}`)
  expect(queue.requestedItem).toMatchObject({ id: steer.id, status: 'applied', runId: run.runId })
  expect((await scenario.stats()).seenSteer).toBe(true)
})

test('确认 running 后停止，终态只能 cancelled，队列暂停且保留普通等待项', async ({ page, model }) => {
  const scenario = await model.create('hold')
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const run = await waitRun(page, appId, item, 'running')
  await expect.poll(async () => (await scenario.stats()).waiting).toBe(true)
  const waitingText = `下一轮生成等待页 ${scenario.marker}`
  const waiting = await send(page, waitingText, '普通')
  expect(waiting).toMatchObject({ mode: 'normal', status: 'queued' })
  await expect(page.getByText('普通消息 · 排队中', { exact: true })).toBeVisible()
  expect((await readRun(page, appId, item)).status).toBe('running')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  const cancelled = await waitRun(page, appId, item, 'cancelled')
  expect(cancelled.runId).toBe(run.runId)
  await expect.poll(async () => {
    const queue = await dataOf(page, `/app/chat/queue?appId=${appId}`)
    return { paused: queue.paused, activeRun: queue.activeRun, waiting: queue.items.find((entry) => entry.id === waiting.id) }
  }).toMatchObject({ paused: true, activeRun: null, waiting: { id: waiting.id, status: 'queued', mode: 'normal' } })
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^已停止/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /继续队列/ })).toBeVisible()
  await expect.poll(async () => (await scenario.stats()).aborted).toBe(true)
  await page.reload()
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  await expect(page.getByText(waitingText, { exact: true })).toBeVisible()
  expect((await readRun(page, appId, item)).status).toBe('cancelled')
  expect(await readRun(page, appId, waiting)).toBeNull()
  expect((await scenario.stats()).requests).toBe(1)
})

test('固定模型返回错误时保留 failed 历史，继续队列后新一轮可成功', async ({ page, model }) => {
  const scenario = await model.create('fail')
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const failed = await waitRun(page, appId, item, 'failed')
  expect(failed.errorCode).toBe('MODEL_ERROR')
  await expect(page.getByText(`模型请求失败：模型故障 ${scenario.marker}`, { exact: true }).first()).toBeVisible()
  await expect(page.getByTitle('应用预览', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: /^生成失败/ })).toBeVisible()
  const retry = await send(page, `重新生成静态页面 ${scenario.marker}`, '普通')
  expect((await dataOf(page, `/app/chat/queue?appId=${appId}`)).paused).toBe(true)
  await page.getByRole('button', { name: /继续队列/ }).click()
  const completed = await waitRun(page, appId, retry, 'completed')
  expect(completed.runId).not.toBe(failed.runId)
  await expectCompleted(page, scenario)
  expect((await readRun(page, appId, item)).status).toBe('failed')
})
