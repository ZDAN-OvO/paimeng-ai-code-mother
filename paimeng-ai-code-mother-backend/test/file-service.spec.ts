import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { FileService, type ToolContext } from '../src/runtime/file-service'

function testConfig(overrides: Partial<Record<'maxFileBytes' | 'maxSourceBytes' | 'maxFileCount', number>> = {}) {
  return {
    appSourceDir: (appId: number) => join(root, String(appId)),
    maxFileBytes: 1024 * 1024,
    maxSourceBytes: 100 * 1024 * 1024,
    maxFileCount: 5000,
    ...overrides,
  } as unknown as AppConfigService
}

let root = ''

function context(appId: number): ToolContext {
  return {
    appId,
    runId: 'run',
    isCancelled: () => false,
    readVersions: new Map(),
    markPreviewChanged: () => undefined,
    emit: () => undefined,
  }
}

async function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  root = await mkdtemp(join(tmpdir(), 'paimeng-files-'))
  await mkdir(join(root, '1'), { recursive: true })
  return new FileService(testConfig(overrides))
}

describe('file service boundaries', () => {
  it('writes, reads and edits with read-before-write checks', async () => {
    const files = await setup()
    const ctx = context(1)
    const written = await files.write(ctx, 'src/app.ts', 'const a = 1\n')
    expect(written.created).toBe(true)
    const read = await files.read(ctx, 'src/app.ts')
    expect(read.content).toContain('const a = 1')
    await files.edit(ctx, 'src/app.ts', [{ oldText: 'const a = 1', newText: 'const a = 2' }])
    expect(await readFile(join(root, '1/src/app.ts'), 'utf8')).toContain('const a = 2')
  })

  it('rejects traversal, absolute paths, reserved files and symlink escapes', async () => {
    const files = await setup()
    const ctx = context(1)
    await expect(files.write(ctx, '../outside.txt', 'x')).rejects.toThrow('..')
    await expect(files.write(ctx, '/etc/passwd', 'x')).rejects.toThrow('绝对路径')
    await expect(files.write(ctx, '.npmrc', 'x')).rejects.toThrow('平台保留')
    const outside = await mkdtemp(join(tmpdir(), 'paimeng-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, '1/link'))
    await expect(files.read(ctx, 'link/secret.txt')).rejects.toThrow('软链接')
  })

  it('rejects access to another app and to the skill registry', async () => {
    const files = await setup()
    await mkdir(join(root, '2'), { recursive: true })
    await writeFile(join(root, '2/secret.txt'), 'other app')
    const ctx = context(1)

    await expect(files.read(ctx, '../2/secret.txt')).rejects.toThrow('..')
    await expect(
      files.write(ctx, '../../.paimeng/skills/static/SKILL.md', 'overwritten'),
    ).rejects.toThrow('..')
    await symlink(join(root, '2'), join(root, '1/other-app'))
    await expect(files.read(ctx, 'other-app/secret.txt')).rejects.toThrow('软链接')
  })

  it('requires a prior read and unique matches before editing', async () => {
    const files = await setup()
    const ctx = context(1)
    await writeFile(join(root, '1/a.txt'), 'x x')
    await expect(files.edit(ctx, 'a.txt', [{ oldText: 'x', newText: 'y' }])).rejects.toThrow('先读取')
    await files.read(ctx, 'a.txt')
    await expect(files.edit(ctx, 'a.txt', [{ oldText: 'x', newText: 'y' }])).rejects.toThrow('必须唯一匹配')
  })

  it('enforces single-file size limit', async () => {
    const files = await setup()
    const ctx = context(1)
    await expect(files.write(ctx, 'big.txt', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow('1 MiB')
  })

  it('truncates a read at 50 KiB and returns a resume offset', async () => {
    const files = await setup()
    const ctx = context(1)
    const content = Array.from(
      { length: 1200 },
      (_, index) => `line-${String(index).padStart(4, '0')}-${'x'.repeat(50)}`,
    ).join('\n')
    await writeFile(join(root, '1/big.txt'), content)

    const read = await files.read(ctx, 'big.txt')
    expect(read.truncated).toBe(true)
    expect(read.content).toContain('51200 字节上限')
    expect(read.nextOffset).toBeGreaterThan(1)
  })

  it('enforces file count and total source size quotas', async () => {
    const countLimited = await setup({ maxFileCount: 2 })
    const countCtx = context(1)
    await countLimited.write(countCtx, 'a.txt', 'a')
    await countLimited.write(countCtx, 'b.txt', 'b')
    await expect(countLimited.write(countCtx, 'c.txt', 'c')).rejects.toThrow('文件数量超过上限')

    const sizeLimited = await setup({ maxSourceBytes: 10 })
    const sizeCtx = context(1)
    await sizeLimited.write(sizeCtx, 'a.txt', '123456')
    await expect(sizeLimited.write(sizeCtx, 'b.txt', '12345')).rejects.toThrow('源码总量超过上限')
  })

  it('requires explicit recursive delete with matching directory version', async () => {
    const files = await setup()
    const ctx = context(1)
    await files.write(ctx, 'dir/a.txt', 'a')
    await expect(files.delete(ctx, 'dir')).rejects.toThrow('recursive')
    const listing = await files.ls(ctx, 'dir', 2)
    const shallow = await files.ls(ctx, 'dir')
    expect(shallow.version).toBe(listing.version)
    await expect(files.delete(ctx, 'dir', true, 'wrong')).rejects.toThrow('核对版本')
    await files.delete(ctx, 'dir', true, shallow.version)
  })

  it('marks source mutations only after writes, edits and deletes succeed', async () => {
    const files = await setup()
    let mutated = 0
    const ctx = { ...context(1), markMutated: () => (mutated += 1) }

    await files.write(ctx, 'a.txt', 'a')
    expect(mutated).toBe(1)
    await files.read(ctx, 'a.txt')
    expect(mutated).toBe(1)
    await files.edit(ctx, 'a.txt', [{ oldText: 'a', newText: 'b' }])
    expect(mutated).toBe(2)
    await files.delete(ctx, 'a.txt')
    expect(mutated).toBe(3)
    await expect(files.delete(ctx, 'missing.txt')).rejects.toThrow()
    expect(mutated).toBe(3)
  })
})
