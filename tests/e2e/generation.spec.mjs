import { test, expect, env, registerAndLogin, createApp, waitRun, expectCompleted } from './fixtures.mjs'

test('注册登录、生成静态页、独立来源预览与刷新恢复', async ({ page, model }) => {
  const scenario = await model.create()
  await registerAndLogin(page)
  const { appId, item } = await createApp(page, scenario)
  await waitRun(page, appId, item, 'completed')
  await expectCompleted(page, scenario)
  const frameUrl = await page.getByTitle('应用预览', { exact: true }).getAttribute('src')
  expect(new URL(frameUrl).hostname).toBe(`app-${appId}.${env.previewDomain}`)
  expect(new URL(frameUrl).origin).not.toBe(env.mainOrigin)
  await page.reload()
  await expectCompleted(page, scenario)
  await expect(page.getByText(scenario.prompt, { exact: true })).toBeVisible()
  expect((await scenario.stats()).requests).toBe(3)
})
