import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../../paimeng-ai-code-mother-frontend')
const require = createRequire(join(frontend, 'package.json'))
const { build } = await import(require.resolve('vite'))
await build({ root: frontend, configFile: join(frontend, 'vite.config.ts'), envDir: false })
