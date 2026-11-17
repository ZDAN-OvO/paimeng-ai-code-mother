import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from './services.mjs'

// 新增的 .mjs 不在 eslint 覆盖范围内（后端 lint 只看 src/**/*.ts 与 test/**/*.ts），
// 至少在这里挡住语法错误，避免只在某个冷门路径被触发时才暴露。
const targets = ['scripts', 'tests', 'paimeng-ai-code-mother-backend/test/integration']
const files = []
for (const target of targets) await collect(join(root, target))

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await collect(path)
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      files.push(path)
    }
  }
}

const failed = []
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) failed.push(`${file}\n${result.stderr.trim()}`)
}
if (failed.length) {
  console.error(failed.join('\n\n'))
  process.exit(1)
}
console.log(`语法检查通过：${files.length} 个文件`)
