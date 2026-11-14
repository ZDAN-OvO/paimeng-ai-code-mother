import { Injectable } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata'])
const ALLOWED_RESOURCE_ROOTS = new Set(['references', 'scripts', 'assets'])
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_RESOURCE_BYTES = 50 * 1024
const MAX_RESOURCE_LINES = 2000

export interface SkillSummary {
  name: string
  description: string
}

interface ParsedSkill extends SkillSummary {
  body: string
  dir: string
}

interface Frontmatter {
  name: string
  description: string
  [key: string]: unknown
}

@Injectable()
export class SkillService {
  // 源码与编译产物都位于后端根目录的下一层，因此这里统一指向 backend/.paimeng/skills。
  private readonly root = resolve(__dirname, '../../.paimeng/skills')
  private readonly cache = new Map<string, ParsedSkill>()

  async list(): Promise<SkillSummary[]> {
    if (!existsSync(this.root)) return []
    const entries = await readdir(this.root, { withFileTypes: true })
    const skills: SkillSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue
      if (!existsSync(join(this.root, entry.name, 'SKILL.md'))) continue
      const parsed = await this.loadParsed(entry.name)
      skills.push({ name: parsed.name, description: parsed.description })
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  async validateAll(): Promise<string[]> {
    const errors: string[] = []
    if (!existsSync(this.root)) return errors
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue
      if (!existsSync(join(this.root, entry.name, 'SKILL.md'))) continue
      try {
        await this.loadParsed(entry.name)
      } catch (err) {
        errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return errors
  }

  async load(name: string): Promise<string> {
    return (await this.loadParsed(name)).body
  }

  async readResource(name: string, relative: string, offset = 0, limit = MAX_RESOURCE_LINES) {
    const skill = await this.loadParsed(name)
    const clean = this.normalizeResourcePath(relative)
    const target = resolve(skill.dir, clean)
    if (!target.startsWith(skill.dir + sep)) throw new Error('技能资源路径越界')
    if (!existsSync(target)) throw new Error(`技能资源 ${relative} 不存在`)
    const real = await realpath(target)
    if (!real.startsWith(skill.dir + sep)) throw new Error('技能资源路径越界（软链接）')
    const info = await stat(real)
    if (!info.isFile()) throw new Error('技能资源必须是文件')
    const text = await readFile(real, 'utf8')
    const lines = text.split('\n')
    const start = Math.max(0, Math.floor(offset) || 0)
    const count = Math.min(MAX_RESOURCE_LINES, Math.max(1, Math.floor(limit) || MAX_RESOURCE_LINES))
    const slice = lines.slice(start, start + count)
    const content = Buffer.from(slice.join('\n'), 'utf8')
    const truncated = content.length > MAX_RESOURCE_BYTES
    const finalContent = truncated
      ? content.subarray(0, MAX_RESOURCE_BYTES).toString('utf8')
      : content.toString('utf8')
    return {
      name,
      path: clean,
      content: finalContent,
      startLine: start + 1,
      endLine: start + slice.length,
      totalLines: lines.length,
      truncated,
      nextOffset: truncated || start + count < lines.length ? start + count : null,
    }
  }

  private normalizeResourcePath(relative: string) {
    if (!relative || typeof relative !== 'string') throw new Error('技能资源路径不能为空')
    if (relative.includes('\0')) throw new Error('技能资源路径包含非法字符')
    const clean = relative.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
    const parts = clean.split('/').filter(Boolean)
    if (parts.length === 0 || parts.includes('..')) throw new Error('技能资源路径非法')
    if (!ALLOWED_RESOURCE_ROOTS.has(parts[0])) {
      throw new Error('技能资源只允许读取 references/、scripts/、assets/')
    }
    return parts.join('/')
  }

  private async loadParsed(name: string): Promise<ParsedSkill> {
    if (!isValidSkillName(name)) throw new Error('技能名称非法')
    const cached = this.cache.get(name)
    if (cached) return cached

    const dir = resolve(this.root, name)
    if (!dir.startsWith(this.root + sep)) throw new Error('技能路径越界')
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) throw new Error(`技能 ${name} 不存在`)

    const raw = await readFile(file, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    const description = frontmatter.description.trim()
    if (frontmatter.name !== name) {
      throw new Error(`技能目录 ${name} 与 frontmatter name=${frontmatter.name} 不一致`)
    }
    if (!description) throw new Error(`技能 ${name} 的 description 不能为空`)
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`技能 ${name} 的 description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`)
    }
    if (description.includes('<') || description.includes('>')) {
      throw new Error(`技能 ${name} 的 description 不能包含尖括号`)
    }
    const trimmedBody = body.trim()
    if (!trimmedBody) throw new Error(`技能 ${name} 的正文不能为空`)

    const parsed: ParsedSkill = {
      name,
      description,
      body: trimmedBody,
      dir,
    }
    this.cache.set(name, parsed)
    return parsed
  }
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const document = parseDocument(match[1], { prettyErrors: false })
  if (document.errors.length > 0) {
    throw new Error(`SKILL.md frontmatter YAML 无效: ${document.errors[0].message}`)
  }
  const value = document.toJS() as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SKILL.md frontmatter 必须是 YAML 对象')
  }
  const frontmatter = value as Record<string, unknown>
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      throw new Error(`SKILL.md frontmatter 包含不支持的字段: ${key}`)
    }
  }
  const name = frontmatter.name
  const description = frontmatter.description
  if (typeof name !== 'string' || !isValidSkillName(name.trim())) {
    throw new Error('SKILL.md frontmatter 缺少合法 name')
  }
  if (typeof description !== 'string') {
    throw new Error('SKILL.md frontmatter 缺少 description')
  }
  return {
    frontmatter: { ...frontmatter, name: name.trim(), description },
    body: raw.slice(match[0].length),
  }
}

function isValidSkillName(name: string) {
  return SKILL_NAME.test(name) && !name.includes('--')
}
