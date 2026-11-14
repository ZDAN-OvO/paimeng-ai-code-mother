import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { AppConfigService } from '../config/config.module'
import { truncateBytes } from '../common/truncate'
import { RESERVED_ROOTS } from './dependency-policy'

export interface ToolContext {
  appId: number
  runId: string
  toolCallId?: string
  isCancelled: () => boolean
  readVersions: Map<string, string>
  markPreviewChanged: () => void
  markMutated?: () => void
  emit: (type: string, payload: Record<string, unknown>) => void
}

const RESERVED_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
])

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

@Injectable()
export class FileService {
  constructor(private readonly config: AppConfigService) {}

  private root(appId: number) {
    return this.config.appSourceDir(appId)
  }

  private async safePath(appId: number, relative: string, allowMissing = false) {
    if (!relative || typeof relative !== 'string') throw new Error('路径不能为空')
    if (relative.includes('\0')) throw new Error('路径包含非法字符')
    const normalized = relative.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('不能使用绝对路径')
    const parts = normalized.split('/').filter((p) => p && p !== '.')
    if (parts.includes('..')) throw new Error('路径不能包含 ..')
    if (parts.length === 0) throw new Error('路径不能为空')
    const first = parts[0].toLowerCase()
    if (RESERVED_ROOTS.has(first) || RESERVED_FILES.has(parts[parts.length - 1])) {
      throw new Error('该路径由平台保留，不能修改')
    }
    const root = this.root(appId)
    let target = resolve(root, ...parts)
    if (!target.startsWith(root + sep)) throw new Error('路径越界')
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      realRoot = root
    }
    if (target === realRoot) throw new Error('不能操作项目根目录')
    if (!allowMissing || existsSync(target)) {
      try {
        const real = await realpath(target)
        if (!real.startsWith(realRoot + sep)) throw new Error('路径越界（软链接）')
        target = real
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    const parent = dirname(target)
    let existing = parent
    while (!existsSync(existing) && existing.length > realRoot.length) existing = dirname(existing)
    const realParent = await realpath(existing)
    if (!realParent.startsWith(realRoot + sep) && realParent !== realRoot) throw new Error('路径越界（软链接）')
    return target
  }

  private async targetForDir(appId: number, relative: string) {
    if (relative === '.' || relative === '' || relative === '/') return this.root(appId)
    return this.safePath(appId, relative)
  }

  private async assertWritable(_appId: number, target: string) {
    if (existsSync(target)) {
      const info = await lstat(target)
      if (info.isSymbolicLink()) throw new Error('不能写入软链接')
      if (!info.isFile() && !info.isDirectory()) throw new Error('只能操作普通文件或目录')
    }
  }

  async read(ctx: ToolContext, relative: string, offset = 1, limit = MAX_READ_LINES) {
    const target = await this.safePath(ctx.appId, relative)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('不是文件')
    if (info.size > this.config.maxFileBytes) throw new Error('文件超过单文件大小限制（1 MiB）')
    const raw = await readFile(target, 'utf8')
    const version = hashContent(raw)
    ctx.readVersions.set(relative, version)
    const lines = raw.split('\n')
    const start = Math.max(0, Math.floor(offset || 1) - 1)
    const count = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limit || MAX_READ_LINES)))
    const slice = lines.slice(start, start + count)
    let content = slice.join('\n')
    const buffer = Buffer.from(content, 'utf8')
    let truncated = false
    let nextOffset: number | null = start + count < lines.length ? start + count + 1 : null
    if (buffer.length > MAX_READ_BYTES) {
      content =
        buffer.subarray(0, MAX_READ_BYTES).toString('utf8') +
        `\n[本次读取达到 ${MAX_READ_BYTES} 字节上限，请用 offset 继续]`
      truncated = true
      const consumed = content.split('\n').length - 1
      nextOffset = start + consumed + 1
    }
    return {
      path: relative,
      content,
      startLine: start + 1,
      endLine: start + slice.length,
      totalLines: lines.length,
      truncated,
      nextOffset: truncated || start + count < lines.length ? nextOffset : null,
      version,
    }
  }

  async write(ctx: ToolContext, relative: string, content: string) {
    if (ctx.isCancelled()) throw new Error('任务已取消，未写入文件')
    const target = await this.safePath(ctx.appId, relative, true)
    await this.assertWritable(ctx.appId, target)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.config.maxFileBytes) throw new Error('文件超过单文件大小限制（1 MiB）')
    const exists = existsSync(target)
    if (exists) {
      const known = ctx.readVersions.get(relative)
      if (!known) throw new Error(`文件 ${relative} 已存在，覆盖前请先读取`)
      const raw = await readFile(target, 'utf8')
      if (hashContent(raw) !== known) throw new Error(`文件 ${relative} 在读取后被其他任务修改，请重新读取后再写入`)
    }
    const stats = await this.sourceStats(ctx.appId)
    if (!exists && stats.files + 1 > this.config.maxFileCount) throw new Error('项目文件数量超过上限（5000）')
    const delta = exists ? bytes - (await stat(target)).size : bytes
    if (stats.bytes + Math.max(0, delta) > this.config.maxSourceBytes) throw new Error('项目源码总量超过上限（100 MiB）')
    await mkdir(dirname(target), { recursive: true })
    const tmp = join(dirname(target), `.paimeng-${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(tmp, content, 'utf8')
    if (ctx.isCancelled()) {
      await rm(tmp, { force: true })
      throw new Error('任务已取消，未写入文件')
    }
    await rename(tmp, target)
    const version = hashContent(content)
    ctx.readVersions.set(relative, version)
    ctx.markPreviewChanged()
    ctx.markMutated?.()
    return { path: relative, bytes, version, created: !exists }
  }

  async edit(ctx: ToolContext, relative: string, edits: Array<{ oldText: string; newText: string }>) {
    if (ctx.isCancelled()) throw new Error('任务已取消，未写入文件')
    if (!edits.length) throw new Error('edits 不能为空')
    const target = await this.safePath(ctx.appId, relative)
    const known = ctx.readVersions.get(relative)
    if (!known) throw new Error(`修改前请先读取文件 ${relative}`)
    const raw = await readFile(target, 'utf8')
    if (hashContent(raw) !== known) throw new Error(`文件 ${relative} 在读取后被其他任务修改，请重新读取后再修改`)
    let updated = raw
    for (const edit of edits) {
      if (!edit.oldText) throw new Error('oldText 不能为空')
      const occurrences = updated.split(edit.oldText).length - 1
      if (occurrences !== 1) throw new Error(`oldText 在文件中匹配到 ${occurrences} 次，必须唯一匹配`)
      updated = updated.replace(edit.oldText, edit.newText)
    }
    const bytes = Buffer.byteLength(updated, 'utf8')
    if (bytes > this.config.maxFileBytes) throw new Error('文件超过单文件大小限制（1 MiB）')
    const stats = await this.sourceStats(ctx.appId)
    const delta = bytes - Buffer.byteLength(raw, 'utf8')
    if (stats.bytes + Math.max(0, delta) > this.config.maxSourceBytes) throw new Error('项目源码总量超过上限（100 MiB）')
    const tmp = join(dirname(target), `.paimeng-${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(tmp, updated, 'utf8')
    if (ctx.isCancelled()) {
      await rm(tmp, { force: true })
      throw new Error('任务已取消，未写入文件')
    }
    await rename(tmp, target)
    const version = hashContent(updated)
    ctx.readVersions.set(relative, version)
    ctx.markPreviewChanged()
    ctx.markMutated?.()
    return { path: relative, bytes, version }
  }

  async delete(ctx: ToolContext, relative: string, recursive = false, expectedVersion?: string) {
    if (ctx.isCancelled()) throw new Error('任务已取消，未删除文件')
    const target = await this.safePath(ctx.appId, relative)
    const info = await lstat(target)
    if (info.isDirectory()) {
      if (!recursive) throw new Error('删除目录需要显式设置 recursive=true')
      const version = await this.directoryVersion(target)
      if (!expectedVersion || version !== expectedVersion) {
        throw new Error(`目录删除前需核对版本：当前 version=${version}，请先 ls 并传入 expectedVersion`)
      }
      if (ctx.isCancelled()) throw new Error('任务已取消，未删除目录')
      await rm(target, { recursive: true, force: false })
      ctx.markPreviewChanged()
      ctx.markMutated?.()
      return { path: relative, deleted: true, kind: 'directory' as const, version }
    }
    const known = ctx.readVersions.get(relative)
    if (!known) throw new Error(`删除文件前请先读取 ${relative}`)
    const raw = await readFile(target, 'utf8')
    if (hashContent(raw) !== known) throw new Error(`文件 ${relative} 在读取后被其他任务修改，请重新读取`)
    if (ctx.isCancelled()) throw new Error('任务已取消，未删除文件')
    await rm(target)
    ctx.readVersions.delete(relative)
    ctx.markPreviewChanged()
    ctx.markMutated?.()
    return { path: relative, deleted: true, kind: 'file' as const, version: known }
  }

  async ls(ctx: ToolContext, relative = '.', depth = 1) {
    const target = await this.targetForDir(ctx.appId, relative)
    const info = await stat(target)
    if (!info.isDirectory()) throw new Error('不是目录')
    const maxDepth = Math.min(3, Math.max(1, Math.floor(depth) || 1))
    const entries: Array<{ path: string; type: 'file' | 'dir'; size: number }> = []
    const walk = async (dir: string, prefix: string, level: number) => {
      if (entries.length >= 500) return
      const list = await readdir(dir, { withFileTypes: true })
      list.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of list) {
        if (entries.length >= 500) return
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          entries.push({ path: rel, type: 'dir', size: 0 })
          if (level < maxDepth) await walk(join(dir, entry.name), rel, level + 1)
        } else if (entry.isFile()) {
          entries.push({ path: rel, type: 'file', size: (await stat(join(dir, entry.name))).size })
        }
      }
    }
    await walk(target, '', 1)
    const version = await this.directoryVersion(target)
    return {
      path: relative,
      entries,
      count: entries.length,
      truncated: entries.length >= 500,
      version,
    }
  }

  /**
   * 目录版本必须与 ls 的 depth 无关，否则模型按默认 depth 列目录后无法删除。
   * 这里对目录树做完整快照（跳过平台目录），并把 mtime 纳入版本，避免同尺寸修改漏检。
   */
  private async directoryVersion(root: string): Promise<string> {
    const rows: string[] = []
    const walk = async (dir: string, prefix: string) => {
      if (rows.length >= this.config.maxFileCount * 2) return
      const list = await readdir(dir, { withFileTypes: true })
      list.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of list) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          rows.push(`d:${rel}`)
          await walk(full, rel)
        } else if (entry.isFile()) {
          const info = await stat(full)
          rows.push(`f:${rel}:${info.size}:${info.mtimeMs}`)
        }
      }
    }
    await walk(root, '')
    return hashContent(rows.join('\n'))
  }

  async grep(ctx: ToolContext, pattern: string, relative = '.', glob?: string, ignoreCase = false) {
    if (!pattern || pattern.length > 500) throw new Error('pattern 长度需在 1-500 之间')
    const target = await this.targetForDir(ctx.appId, relative)
    const args = ['-n', '--no-heading', '--color', 'never', '--max-columns', '500', '-m', '100']
    if (ignoreCase) args.push('-i')
    if (glob) args.push('--glob', glob)
    args.push('--', pattern, target)
    const result = await this.exec(rgPath, args, 10_000)
    const output = result.stdout || (result.code === 1 ? '无匹配' : result.stderr)
    const truncated = truncateBytes(output, this.config.toolOutputMaxBytes)
    return {
      pattern,
      matches: truncated.text,
      truncated: truncated.truncated,
      code: result.code,
      note: '最多返回 100 条匹配，超出请缩小范围',
    }
  }

  async find(ctx: ToolContext, pattern: string, relative = '.') {
    if (!pattern || pattern.length > 500) throw new Error('pattern 长度需在 1-500 之间')
    const target = await this.targetForDir(ctx.appId, relative)
    const result = await this.exec(rgPath, ['--files', '--glob', pattern, '--', target], 10_000)
    const lines = (result.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 1000)
    return { pattern, files: lines, count: lines.length, truncated: lines.length >= 1000 }
  }

  private exec(bin: string, args: string[], timeoutMs: number) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolveExec) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const cap = this.config.toolOutputMaxBytes * 2
      child.stdout.on('data', (c: Buffer) => {
        stdout = (stdout + c.toString('utf8')).slice(0, cap)
      })
      child.stderr.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString('utf8')).slice(0, cap)
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolveExec({ code: -1, stdout, stderr: err.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveExec({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  async sourceStats(appId: number) {
    const root = this.root(appId)
    let files = 0
    let bytes = 0
    const walk = async (dir: string) => {
      const list = await readdir(dir, { withFileTypes: true })
      for (const entry of list) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          files += 1
          bytes += (await stat(full)).size
        }
      }
    }
    if (existsSync(root)) await walk(root)
    return { files, bytes }
  }
}
