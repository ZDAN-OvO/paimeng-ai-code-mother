import { test, expect, registerAndLogin, createApp, waitRun, expectCompleted } from './fixtures.mjs'

test('旧历史在实时文本渲染后返回，不能清空同一轮助手内容', async ({ page, model }) => {
  const scenario = await model.create('hold-before-text')
  await registerAndLogin(page)
  let captured
  const historyCaptured = new Promise((resolve) => { captured = resolve })
  let releaseHistory
  const historyGate = new Promise((resolve) => { releaseHistory = resolve })
  let held = false
  await page.route('**/api/chatHistory/app/*', async (route) => {
    const response = await route.fetch()
    const snapshot = await response.json()
    const assistant = snapshot.data?.records.find((item) => item.role === 'assistant' && item.status === 'streaming')
    if (!held && assistant) {
      held = true
      captured({ assistant, status: response.status() })
      await historyGate
    }
    await route.fulfill({ response })
  })
  try {
    const { appId, item } = await createApp(page, scenario)
    const run = await waitRun(page, appId, item, 'running')
    const snapshot = await historyCaptured
    expect(snapshot.status).toBe(200)
    expect(snapshot.assistant.runId).toBe(run.runId)
    expect(snapshot.assistant.content.parts).toEqual([])
    await expect.poll(async () => (await scenario.stats()).waiting).toBe(true)
    await scenario.release()
    await expect(page.getByText(scenario.partial, { exact: true })).toBeVisible()
    // 旧历史只有在 SSE 文本真正可见后才送达，此后模型仍被第二道闸门挡住。
    releaseHistory()
    await expect(page.getByText('正在加载对话…', { exact: true })).toBeHidden()
    await expect(page.getByText(scenario.partial, { exact: true })).toBeVisible()
    await expect(page.locator('article.message-assistant')).toHaveCount(1)
    await scenario.release()
    await waitRun(page, appId, item, 'completed')
    await expectCompleted(page, scenario)
  } finally {
    releaseHistory()
    await page.unrouteAll({ behavior: 'wait' })
  }
})
