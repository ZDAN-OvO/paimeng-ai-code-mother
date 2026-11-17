import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { browserEnvironment, repoRoot } from './environment.mjs'

// DOCKER_BIN 指向记录型替身。启动阶段本来就会做只读探测（network inspect、ps label、
// inspect paimeng-app-*），这些允许；但任何会真正执行生成代码的命令都不允许出现，
// 否则说明这轮「静态页面」测试已经越界去跑容器了。
const FORBIDDEN = /^(run|create|start|exec|build|kill|rm|push|commit|cp)\b/

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
  const preserved = join(repoRoot, 'test-results', 'docker-calls.log')
  await mkdir(dirname(preserved), { recursive: true })
  await copyFile(audit, preserved)
  const forbidden = calls.split('\n').filter((line) => FORBIDDEN.test(line.trim()))
  if (forbidden.length) {
    throw new Error(`PR 测试期间试图执行会跑生成代码的 Docker 命令（记录见 test-results/docker-calls.log）：\n${forbidden.join('\n')}`)
  }
}
