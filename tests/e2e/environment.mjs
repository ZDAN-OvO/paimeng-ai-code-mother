import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export function browserEnvironment(env = process.env) {
  if (env.CI_TEST_ISOLATED !== '1') throw new Error('浏览器测试要求 CI_TEST_ISOLATED=1')
  const databaseUrl = isolatedUrl(env.CI_TEST_DATABASE_URL, ['postgres:', 'postgresql:'])
  if (!/^\/paimeng_ci_[a-z0-9_]{6,}$/i.test(databaseUrl.pathname)) {
    throw new Error('CI_TEST_DATABASE_URL 必须使用随机 paimeng_ci_<随机> 库名')
  }
  const redisUrl = isolatedUrl(env.CI_TEST_REDIS_URL, ['redis:'])
  if (redisUrl.pathname !== '/15') throw new Error('CI_TEST_REDIS_URL 必须使用隔离 Redis 的 DB15')
  const rawWork = env.CI_TEST_WORK_DIR
  if (!rawWork || !isAbsolute(rawWork)) throw new Error('CI_TEST_WORK_DIR 必须是临时私有绝对路径')
  const workDir = resolve(rawWork)
  const parent = dirname(workDir)
  const temp = realpathSync(tmpdir())
  for (const dir of [parent, workDir]) {
    const rel = relative(temp, dir)
    const info = lstatSync(dir)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ||
        info.isSymbolicLink() || !info.isDirectory() || realpathSync(dir) !== dir ||
        info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('工作目录及父目录必须是当前用户拥有的独立临时目录，权限 0700')
    }
    // main.js 会自动探测这两个位置；仅检查目录项，不打开任何 .env 文件。
    try {
      lstatSync(resolve(dir, '.env'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    throw new Error('工作目录或父目录存在 .env，拒绝启动')
  }
  const webPort = port(env.CI_TEST_WEB_PORT, 4173)
  const backendPort = port(env.CI_TEST_BACKEND_PORT, 18123)
  const modelPort = port(env.CI_TEST_MODEL_PORT, 18124)
  if (new Set([webPort, backendPort, modelPort]).size !== 3) throw new Error('测试端口不能重复')
  return {
    workDir, webPort, backendPort, modelPort,
    databaseUrl: databaseUrl.href,
    redisUrl: redisUrl.href,
    mainOrigin: `http://paimeng.localhost:${webPort}`,
    previewDomain: 'preview.paimeng.localhost',
    backendOrigin: `http://127.0.0.1:${backendPort}`,
    modelOrigin: `http://127.0.0.1:${modelPort}`,
    probeOrigin: `http://127.0.0.1:${webPort}`,
  }
}

function isolatedUrl(raw, protocols) {
  let url
  try { url = new URL(raw) } catch { throw new Error('缺少合法的隔离数据库或 Redis URL') }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.search || url.hash) {
    throw new Error('隔离数据库与 Redis 只允许 loopback URL，不能附加查询参数')
  }
  return url
}

function port(raw, fallback) {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('测试端口无效')
  return value
}
