/* 平台预览配置：从 /app 解析 Vite 并加载用户配置。 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const previewPort = Number(process.env.PREVIEW_PORT || 8090)
const protocol = process.env.PREVIEW_SCHEME === 'https' ? 'wss' : 'ws'

type AnyRecord = Record<string, unknown>

export default async function platformConfig(env: { command: string; mode: string }) {
  let user: AnyRecord = {}
  try {
    const req = createRequire('/app/package.json')
    const vite = await import(pathToFileURL(req.resolve('vite')).href)
    const loaded = await vite.loadConfigFromFile(
      { command: 'serve', mode: env.mode || 'development' },
      '/app/vite.config.ts',
      '/app',
    )
    if (loaded?.config) user = loaded.config as AnyRecord
  } catch (error) {
    console.error('[platform] 无法加载用户 vite 配置，将使用平台默认配置', error)
  }
  const userServer = (user.server ?? {}) as AnyRecord
  const userHmr = (userServer.hmr ?? {}) as AnyRecord
  return {
    ...user,
    base: '/',
    cacheDir: '/tmp/vite-cache',
    server: {
      ...userServer,
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      allowedHosts: true,
      hmr: {
        ...userHmr,
        clientPort: previewPort,
        protocol,
      },
    },
  }
}
