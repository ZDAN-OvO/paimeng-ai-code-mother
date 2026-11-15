import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { buildOpenApiDocument } from './document'

async function main() {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false })
  app.setGlobalPrefix('api')
  const content = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`
  const target = join(process.cwd(), 'openapi.json')
  await app.close()
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) {
      console.error('openapi.json 已过期，请运行 pnpm openapi:export')
      process.exit(1)
    }
    return
  }
  writeFileSync(target, content)
}

void main()
