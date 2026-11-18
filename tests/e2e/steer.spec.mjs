import { test, expect, env, registerAndLogin, createApp, waitRun, send, readRun, streamRun, sseFrames, expectCompleted, preview, dataOf } from './fixtures.mjs'

test('运行中插话经真实队列消费，刷新后重新订阅并完成同一轮', async ({ page, model }) => {
  const scenario = await model.create('hold')
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  const run = await waitRun(page, appId, item, 'running')
  await expect.poll(async () => (await scenario.stats()).waiting).toBe(true)
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
  // 界面能看到不够：历史接口也能返回已落库的文本。页面这条订阅只证明「重订阅了同一个运行」。
  await expect(page.getByText(scenario.partial, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
  await expect(page.getByText('插话发送 · 等待插入当前轮次', { exact: true })).toBeVisible()
  expect((await readRun(page, appId, item)).runId).toBe(run.runId)
  // 页面的订阅只证明「刷新后确实又订阅了同一个运行」。要证明「服务端还在推」，
  // 必须有一条跨过放行点的长连接：只有重放旧帧就关流的实现，拿不到放行后才产生的帧。
  const session = (await page.context().cookies(env.mainOrigin)).find((entry) => entry.name === 'pm_sid')
  expect(session).toBeTruthy()
  const live = streamRun(`pm_sid=${session.value}`, run.runId)
  try {
    // 先确认订阅已经建立、并且已经收到这个运行的重放帧，再放行；否则「订阅晚到 + 只回快照」会蒙过去。
    await live.ready
    await expect.poll(() => /"type":"start"/.test(live.frames()), {
      message: '订阅建立后应先收到该运行的重放帧', timeout: 10_000,
    }).toBe(true)
    await scenario.release()
    // 必须等服务端自己把流收尾：提前断流、永久挂流、只回快照都会在这里露馅。
    await expect.poll(() => live.ended() || live.failure(), {
      message: '运行结束后订阅应正常关闭', timeout: 20_000,
    }).toBe(true)
    const frames = sseFrames(live.frames())
    expect(live.failure(), '这条订阅不能异常中断').toBeNull()
    expect(live.ended(), '订阅应自行结束').toBe(true)
    const at = (pattern) => frames.findIndex((frame) => pattern.test(frame))
    const validation = at(/"type":"data-validation"[^\n]*"check":"source"/)
    const finalText = frames.findIndex((frame) => frame.includes(`页面已完成 ${scenario.marker}`))
    const terminal = at(/"type":"data-run"[^\n]*"status":"completed"/)
    // [DONE] 必须是唯一的最后一帧：提前发一个再补帧的实现，用「包含」判断会漏掉。
    const done = frames.map((frame, index) => (frame === '[DONE]' ? index : -1)).filter((index) => index >= 0)
    expect(done, '流里必须且只能有一个 [DONE]').toHaveLength(1)
    expect(done[0], '[DONE] 必须是最后一帧').toBe(frames.length - 1)
    expect(validation, '放行后应有写入校验帧，重放快照里不可能有').toBeGreaterThan(-1)
    expect(finalText, '放行后应收到最终文本').toBeGreaterThan(-1)
    expect(terminal, '结束时应有 completed 终态帧').toBeGreaterThan(-1)
    expect(done[0], '[DONE] 必须在终态帧之后').toBeGreaterThan(terminal)
  } finally {
    if (process.env.CI_TEST_EVIDENCE === '1') await test.info().attach('live-sse', { body: live.frames(), contentType: 'text/plain' })
    live.close()
  }
  const completed = await waitRun(page, appId, item, 'completed')
  expect(completed.runId).toBe(run.runId)
  await expectCompleted(page, scenario, `；已应用插话：${scenario.steer}`)
  await expect(page.getByText('插入指令', { exact: true })).toBeVisible()
  await expect(page.getByText(scenario.steer, { exact: true })).toBeVisible()
  await expect(preview(page).getByText(`页面已生成；已应用插话：${scenario.steer}`, { exact: true })).toBeVisible()
  const queue = await dataOf(page, `/app/chat/queue?appId=${appId}&clientRequestId=${steer.clientRequestId}`)
  expect(queue.requestedItem).toMatchObject({ id: steer.id, status: 'applied', runId: run.runId })
  expect((await scenario.stats()).seenSteer).toBe(true)
})
