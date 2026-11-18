import { test as base, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { browserEnvironment } from './environment.mjs'

export const env = browserEnvironment()
export const password = 'BrowserFlow-password-2026'
const draftPlaceholder = '描述你想做的页面，或继续提出修改…'
export const test = base.extend({
  proof: [async ({ page }, use, testInfo) => {
    await use()
    if (process.env.CI_TEST_EVIDENCE === '1' && !page.isClosed()) {
      await testInfo.attach('final-page', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      })
    }
  }, { auto: true }],
  model: async ({}, use, testInfo) => {
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
    for (const marker of markers) {
      try {
        if (process.env.CI_TEST_EVIDENCE === '1') {
          await testInfo.attach(`model-${marker}`, {
            body: JSON.stringify(await control(`/__control/scenarios/${marker}`), null, 2),
            contentType: 'application/json',
          })
        }
      } finally { await control(`/__control/scenarios/${marker}`, 'DELETE') }
    }
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
export async function api(page, path, method = 'GET', data) {
  const result = await page.evaluate(async ({ path, method, data }) => {
    const response = await fetch(`/api${path}`, {
      method, credentials: 'include', headers: { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, body: await response.json() }
  }, { path, method, data })
  if (process.env.CI_TEST_EVIDENCE === '1') {
    await test.info().attach('api-observation', {
      body: JSON.stringify({ path, method, ...result }, null, 2), contentType: 'application/json',
    })
  }
  return result
}

export async function dataOf(page, path) {
  const result = await api(page, path)
  expect(result.status).toBe(200)
  expect(result.body.code).toBe(0)
  return result.body.data
}

// 原生 HTTP 明确保留 Host，Node fetch 的 Host 处理不能用于证明预览来源保护。
export async function hostRequest(path, headers, data) {
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

export async function registerAndLogin(page) {
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

export async function createApp(page, scenario) {
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

export async function send(page, message, mode) {
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

export async function readRun(page, appId, item) {
  const result = await api(page, `/app/run/status?appId=${appId}&clientRequestId=${item.clientRequestId}`)
  // 派发前允许暂时没有运行记录；其他错误必须暴露。
  if (result.status === 404) return null
  expect(result.status).toBe(200)
  expect(result.body.code).toBe(0)
  return result.body.data
}

export async function waitRun(page, appId, item, status) {
  await expect.poll(async () => (await readRun(page, appId, item))?.status, {
    message: `运行必须进入 ${status}`, timeout: 12_000,
  }).toBe(status)
  return readRun(page, appId, item)
}

export function preview(page) { return page.frameLocator('iframe[title="应用预览"]') }

// 按 SSE 帧切开：每个 data: 负载一项，[DONE] 单独保留，便于校验顺序而不只是「存在」。
export function sseFrames(body) {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n'))
    .filter(Boolean)
}

// 独立开一条真实订阅并持续读到关闭：用来证明放行之后服务端仍在推送，而不是只重放旧帧就关流。
// ready 在拿到响应头时兑现：调用方必须先等到它，否则「订阅晚建立 + 只回快照」的假实现也能过。
export function streamRun(cookie, runId) {
  const parts = []
  const state = { status: 0, contentType: '', ended: false, failure: null }
  let settle
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const fail = (error) => {
    state.failure ??= error
    settle.reject(error)
  }
  const request = httpRequest(`${env.probeOrigin}/api/app/run/stream`, {
    method: 'POST',
    headers: {
      Host: new URL(env.mainOrigin).host,
      Cookie: cookie,
      'content-type': 'application/json',
    },
  }, (response) => {
    state.status = response.statusCode
    state.contentType = String(response.headers['content-type'] ?? '')
    if (state.status !== 200 || !state.contentType.includes('text/event-stream')) {
      fail(new Error(`订阅异常：${state.status} ${state.contentType}`))
      response.resume()
      return
    }
    settle.resolve()
    response.setEncoding('utf8')
    response.on('data', (part) => { parts.push(part) })
    response.on('end', () => { state.ended = true })
    response.on('error', (error) => { state.ended = true; state.failure ??= error })
  })
  const timer = setTimeout(() => request.destroy(new Error('run stream timed out')), 30_000)
  request.on('error', (error) => { state.ended = true; fail(error) })
  request.on('close', () => clearTimeout(timer))
  request.end(JSON.stringify({ runId }))
  return {
    ready, state,
    frames: () => parts.join(''),
    ended: () => state.ended,
    failure: () => state.failure,
    close: () => request.destroy(),
  }
}

export async function expectCompleted(page, scenario, suffix = '') {
  await expect(page.getByText(`页面已完成 ${scenario.marker}${suffix}`, { exact: true })).toBeVisible()
  await expect(preview(page).getByRole('heading', { name: scenario.marker, exact: true })).toBeVisible()
  await expect(page.getByText('预览运行中', { exact: true })).toBeVisible()
  const stats = await scenario.stats()
  expect(stats.calls).toEqual(['update_plan', 'write'])
}

export { expect, randomUUID }
