#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { backend, frontend, root, run } from './ci/services.mjs'
import { runSuite } from './ci/run.mjs'

const scopes = {
  backend: { cwd: backend, directory: 'test', suffix: '.spec.ts' },
  frontend: { cwd: frontend, directory: 'test', suffix: '.test.ts' },
  ci: { cwd: root, directory: 'tests/ci', suffix: '.test.mjs' },
  integration: { cwd: backend, directory: 'test/integration', suffix: '.test.mjs' },
}
const [scope, ...names] = process.argv.slice(2)
try {
  const config = scopes[scope]
  if (!config) throw new Error('用法：pnpm test:module <backend|frontend|ci|integration> <名称...|--list>')
  const available = (await readdir(join(config.cwd, config.directory)))
    .filter((file) => file.endsWith(config.suffix))
    .map((file) => file.slice(0, -config.suffix.length))
    .sort()
  if (names.length === 1 && names[0] === '--list') console.log(available.join('\n'))
  else {
    if (!names.length || names.some((name) => !available.includes(name))) {
      throw new Error(`必须指定存在的模块名；用 pnpm test:module ${scope} --list 查看。不会回退运行全套。`)
    }
    if (scope === 'integration') {
      if (names.length !== 1) throw new Error('integration 每次指定一个模块；全套用 pnpm test:integration')
      await runSuite('integration', names[0])
    } else {
      const files = [...new Set(names)].map((name) => join(config.directory, name + config.suffix))
      if (scope === 'backend') await run('pnpm', ['exec', 'vitest', 'run', ...files], { cwd: config.cwd })
      else
        await run(
          process.execPath,
          ['--test', ...(scope === 'frontend' ? ['--test-isolation=none'] : []), ...files],
          { cwd: config.cwd },
        )
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
