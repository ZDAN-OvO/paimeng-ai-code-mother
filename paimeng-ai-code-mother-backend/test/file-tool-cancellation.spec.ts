import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { FileService, type ToolContext } from '../src/runtime/file-service'
import { useTempDirs } from './support/temp-dir'

const tempDir = useTempDirs()

async function setupFiles() {
  const root = await tempDir('paimeng-cancel-files-')
  const files = new FileService({
    appSourceDir: (appId: number) => join(root, String(appId)),
    maxFileBytes: 1024 * 1024,
    maxSourceBytes: 100 * 1024 * 1024,
    maxFileCount: 5000,
  } as unknown as AppConfigService)
  await mkdir(join(root, '1'), { recursive: true })
  return { root, files }
}

function toolContext(isCancelled: () => boolean): ToolContext {
  return {
    appId: 1,
    runId: 'run',
    isCancelled,
    readVersions: new Map(),
    markPreviewChanged: () => undefined,
    emit: () => undefined,
  }
}

describe('file tool cancellation', () => {
  it('does not write when cancellation is already requested', async () => {
    const { root, files } = await setupFiles()
    await expect(
      files.write(
        toolContext(() => true),
        'index.html',
        '<h1>x</h1>',
      ),
    ).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(false)
  })

  it('removes the staged temp file when cancellation arrives during write', async () => {
    const { root, files } = await setupFiles()
    let checks = 0
    const ctx = toolContext(() => {
      checks += 1
      return checks >= 2
    })
    await expect(files.write(ctx, 'index.html', '<h1>x</h1>')).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(false)
    expect(existsSync(join(root, '1'))).toBe(true)
  })

  it('leaves the original file unchanged when cancellation arrives during edit', async () => {
    const { root, files } = await setupFiles()
    await writeFile(join(root, '1/index.html'), '<h1>old</h1>')
    let checks = 0
    const ctx = toolContext(() => {
      checks += 1
      return checks >= 2
    })
    await files.read(ctx, 'index.html')
    await expect(files.edit(ctx, 'index.html', [{ oldText: 'old', newText: 'new' }])).rejects.toThrow(
      '任务已取消',
    )
    expect(await readFile(join(root, '1/index.html'), 'utf8')).toBe('<h1>old</h1>')
  })

  it('does not delete when cancellation is already requested', async () => {
    const { root, files } = await setupFiles()
    await writeFile(join(root, '1/index.html'), '<h1>x</h1>')
    await expect(
      files.delete(
        toolContext(() => true),
        'index.html',
      ),
    ).rejects.toThrow('任务已取消')
    expect(existsSync(join(root, '1/index.html'))).toBe(true)
  })
})
