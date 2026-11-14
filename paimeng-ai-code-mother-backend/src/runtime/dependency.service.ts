import { Injectable } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppConfigService } from '../config/config.module'
import { truncateBytes } from '../common/truncate'
import { FileService, ToolContext } from './file-service'
import { ALLOWED_DEPENDENCIES, validateManifest, Manifest } from './dependency-policy'
import { RuntimeService } from './runtime.service'

@Injectable()
export class DependencyService {
  constructor(
    private readonly config: AppConfigService,
    private readonly files: FileService,
    private readonly runtime: RuntimeService,
  ) {}

  listAllowed() {
    return Object.entries(ALLOWED_DEPENDENCIES)
      .map(([name, range]) => ({ name, range }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async readManifest(appId: number): Promise<Manifest | null> {
    const file = join(this.config.appSourceDir(appId), 'package.json')
    if (!existsSync(file)) return null
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Manifest
    } catch (err) {
      throw new Error(`package.json 解析失败: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  private async writeManifest(ctx: ToolContext, manifest: Manifest) {
    const text = `${JSON.stringify(manifest, null, 2)}\n`
    const current = await this.files.read(ctx, 'package.json')
    const version = await this.files.write(ctx, 'package.json', text)
    void current
    return version
  }

  async listInstalled(appId: number) {
    const dir = join(this.config.appDepsDir(appId), 'node_modules')
    if (!existsSync(dir)) return { installed: [], note: '尚未安装依赖' }
    const entries = await readdir(dir, { withFileTypes: true })
    const result: Array<{ name: string; version: string }> = []
    const readPkg = async (name: string) => {
      try {
        const pkg = JSON.parse(await readFile(join(dir, ...name.split('/'), 'package.json'), 'utf8')) as {
          version?: string
        }
        if (pkg.version) result.push({ name, version: pkg.version })
      } catch {
        /* ignore */
      }
    }
    for (const entry of entries) {
      if (result.length >= 300) break
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        const scoped = await readdir(join(dir, entry.name), { withFileTypes: true })
        for (const sub of scoped) await readPkg(`${entry.name}/${sub.name}`)
      } else {
        await readPkg(entry.name)
      }
    }
    return { installed: result.sort((a, b) => a.name.localeCompare(b.name)), note: '仅列出顶层已安装依赖' }
  }

  async add(ctx: ToolContext, packages: Array<{ name: string; version: string }>) {
    if (!packages.length) throw new Error('packages 不能为空')
    const manifest = await this.readManifest(ctx.appId)
    if (!manifest) throw new Error('项目缺少 package.json，请先按技能创建项目清单')
    const next: Manifest = { ...manifest, dependencies: { ...(manifest.dependencies ?? {}) } }
    for (const pkg of packages) {
      if (!(pkg.name in ALLOWED_DEPENDENCIES)) {
        throw new Error(`依赖 ${pkg.name} 不在平台允许清单中，请使用 list_allowed 查看`)
      }
      next.dependencies![pkg.name] = pkg.version
    }
    const validation = validateManifest(next)
    if (!validation.ok) throw new Error(`依赖声明不符合平台策略: ${validation.errors.join('; ')}`)
    await this.writeManifest(ctx, next)
    return this.sync(ctx)
  }

  async remove(ctx: ToolContext, names: string[]) {
    if (!names.length) throw new Error('names 不能为空')
    const manifest = await this.readManifest(ctx.appId)
    if (!manifest) throw new Error('项目缺少 package.json')
    const next: Manifest = { ...manifest }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (!next[field]) continue
      const copy = { ...next[field] }
      for (const name of names) delete copy[name]
      next[field] = copy
    }
    await this.writeManifest(ctx, next)
    return this.sync(ctx)
  }

  async sync(ctx: ToolContext) {
    const result = await this.runtime.ensureDependencies(ctx.appId, ctx.isCancelled)
    const truncated = truncateBytes(result.logs, this.config.toolOutputMaxBytes)
    return {
      ok: result.ok,
      changed: result.changed,
      error: result.error ?? null,
      logs: truncated.text,
      logsTruncated: truncated.truncated,
      durationMs: result.durationMs,
    }
  }
}
