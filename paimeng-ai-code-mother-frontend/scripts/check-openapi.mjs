import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { generateService } from '@umijs/openapi'

const root = fileURLToPath(new URL('..', import.meta.url))
const jiti = createJiti(import.meta.url)
const config = (await jiti.import(join(root, 'openapi2ts.config.ts'))).default
const target = join(root, 'src/api/generated/api')
const temp = mkdtempSync(join(tmpdir(), 'paimeng-openapi-'))

function files(dir, base = dir, result = new Map()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files(full, base, result)
    else result.set(relative(base, full), readFileSync(full, 'utf8'))
  }
  return result
}

try {
  await generateService({ ...config, serversPath: temp, projectName: 'api' })
  const expected = files(join(temp, 'api'))
  const actual = files(target)
  const paths = new Set([...expected.keys(), ...actual.keys()])
  const changed = [...paths].filter((path) => expected.get(path) !== actual.get(path))
  if (changed.length) {
    console.error(`生成的接口代码已过期，请运行 pnpm openapi：\n${changed.join('\n')}`)
    process.exit(1)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
