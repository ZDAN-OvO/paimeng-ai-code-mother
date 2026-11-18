import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { browserEnvironment, repoRoot } from './environment.mjs'

// DOCKER_BIN 指向记录型替身，所有调用只记录并失败。启动阶段允许 network inspect/create、
// ps label、inspect paimeng-app-* 的尝试；会构建或执行生成应用容器的命令一律不允许出现。
// `image`、`buildx` 也一起拦：静态流程走到镜像操作，下一步就是 build 或 run，已经越界。
const FORBIDDEN = /^(run|create|start|stop|exec|build|kill|rm|pull|push|commit|cp|image|container|buildx)\b/

export default async function globalTeardown() {
  const env = browserEnvironment()
  const audit = join(env.workDir, 'docker-calls.log')
  let calls = ''
  try {
    calls = (await readFile(audit, 'utf8')).trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!calls) return
  // 运行目录随后会被 runner 删除，审计记录必须搬进产物目录。
  const preserved = join(process.env.CI_TEST_RESULTS_DIR ?? join(repoRoot, 'test-results'), 'docker-calls.log')
  await mkdir(dirname(preserved), { recursive: true })
  await copyFile(audit, preserved)
  const forbidden = calls.split('\n').filter((line) => FORBIDDEN.test(line.trim()))
  if (forbidden.length) {
    throw new Error(`PR 测试期间试图执行会跑生成代码的 Docker 命令（记录见 ${preserved}）：\n${forbidden.join('\n')}`)
  }
}
