import { test, expect, env, randomUUID, password, api, hostRequest, registerAndLogin, createApp, waitRun, expectCompleted } from './fixtures.mjs'

test('拒绝跨账号与预览来源访问', async ({ page, browser, model }) => {
  const scenario = await model.create()
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const run = await waitRun(page, appId, item, 'completed')
  await expectCompleted(page, scenario)
  const frameUrl = await page.getByTitle('应用预览', { exact: true }).getAttribute('src')
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
