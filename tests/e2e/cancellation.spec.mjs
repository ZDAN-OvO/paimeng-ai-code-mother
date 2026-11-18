import { test, expect, registerAndLogin, createApp, waitRun, send, readRun, dataOf } from './fixtures.mjs'

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
