import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import semver from 'semver'
import { ApiException } from '../common/api'

export const ALLOWED_DEPENDENCIES: Record<string, string> = {
  vite: '^7.0.0',
  typescript: '~5.9.0',
  vue: '^3.5.0',
  '@vitejs/plugin-vue': '^6.0.0',
  'vue-tsc': '^3.0.0',
  'vue-router': '^4.5.0',
  pinia: '^3.0.0',
  react: '^19.1.0',
  'react-dom': '^19.1.0',
  '@vitejs/plugin-react': '^5.0.0',
  '@types/react': '^19.1.0',
  '@types/react-dom': '^19.1.0',
  tailwindcss: '^4.1.0',
  '@tailwindcss/vite': '^4.1.0',
  'lucide-vue-next': '^1.0.0',
  'lucide-react': '^1.0.0',
}

export const RESERVED_ROOTS = new Set([
  'node_modules',
  'dist',
  '.npmrc',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'pnpmfile.js',
  '.git',
  '.vite',
  '.cache',
])

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export interface Manifest {
  name?: string
  private?: boolean
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

export interface ManifestValidation {
  ok: boolean
  errors: string[]
  filtered: Manifest | null
}

function invalidSpecReason(name: string, spec: string): string | null {
  const trimmed = spec.trim()
  if (!trimmed) return `${name} 的版本为空`
  if (/^(file|link|git|git\+|https?|ssh|npm|workspace|portal|patch|github):/i.test(trimmed)) {
    return `${name} 使用了不允许的来源 ${spec}`
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.endsWith('.tgz') || trimmed.endsWith('.tar.gz')) {
    return `${name} 使用了不允许的路径或压缩包来源 ${spec}`
  }
  const range = semver.validRange(trimmed)
  if (!range) return `${name} 的版本范围 ${spec} 无效（只接受精确 semver 范围）`
  return null
}

export function validateManifest(manifest: Manifest): ManifestValidation {
  const errors: string[] = []
  const filtered: Manifest = {
    name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : 'paimeng-app',
    private: true,
    type: manifest.type === 'module' ? 'module' : undefined,
    scripts: {},
  }

  if (manifest.packageManager !== undefined) {
    errors.push('不允许声明 packageManager，安装由平台管理')
  }

  for (const field of DEPENDENCY_FIELDS) {
    const record = manifest[field]
    if (record === undefined) continue
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`${field} 必须是对象`)
      continue
    }
    const accepted: Record<string, string> = {}
    for (const [name, spec] of Object.entries(record)) {
      const allowedRange = ALLOWED_DEPENDENCIES[name]
      if (!allowedRange) {
        errors.push(`${name} 不在允许的直接依赖清单中`)
        continue
      }
      if (typeof spec !== 'string') {
        errors.push(`${name} 的版本声明必须是字符串`)
        continue
      }
      const specError = invalidSpecReason(name, spec)
      if (specError) {
        errors.push(specError)
        continue
      }
      const range = semver.validRange(spec) as string
      if (!semver.subset(range, allowedRange, { includePrerelease: false })) {
        errors.push(`${name}@${spec} 超出平台允许范围 ${allowedRange}`)
        continue
      }
      accepted[name] = spec
    }
    if (Object.keys(accepted).length > 0) {
      filtered[field] = accepted
    }
  }

  if (manifest.scripts && typeof manifest.scripts === 'object') {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command === 'string' && command.length <= 500) filtered.scripts![name] = command
    }
  }

  return { ok: errors.length === 0, errors, filtered: errors.length === 0 ? filtered : null }
}

export function filteredManifest(manifest: Manifest): Manifest | null {
  const result = validateManifest(manifest)
  return result.ok ? result.filtered : null
}

export function inspectProject(sourceDir: string): {
  hasPackageJson: boolean
  manifest: Manifest | null
  manifestError: string | null
  kind: 'static' | 'vue' | 'react'
  scripts: Record<string, string>
  hasBuild: boolean
  hasDev: boolean
  hasTypecheck: boolean
} {
  const pkgPath = join(sourceDir, 'package.json')
  const hasPackageJson = existsSync(pkgPath)
  let manifest: Manifest | null = null
  let manifestError: string | null = null
  if (hasPackageJson) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        manifestError = 'package.json 必须是对象'
      } else {
        manifest = parsed as Manifest
      }
    } catch (err) {
      manifestError = `package.json 解析失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) }
  let kind: 'static' | 'vue' | 'react' = 'static'
  if (manifest) {
    if (deps.react || deps['react-dom']) kind = 'react'
    else if (deps.vue) kind = 'vue'
  }
  const scripts = manifest?.scripts ?? {}
  return {
    hasPackageJson,
    manifest,
    manifestError,
    kind,
    scripts,
    hasBuild: typeof scripts.build === 'string',
    hasDev: typeof scripts.dev === 'string',
    hasTypecheck: typeof scripts.typecheck === 'string',
  }
}

export function requireValidManifest(manifest: Manifest | null): Manifest {
  if (!manifest) throw ApiException.badRequest('package.json 不存在或无法解析')
  const validation = validateManifest(manifest)
  if (!validation.ok) {
    throw ApiException.badRequest(`依赖声明不符合平台策略: ${validation.errors.join('; ')}`)
  }
  return validation.filtered as Manifest
}

export function stableDependencyHash(manifest: Manifest): string {
  const relevant = {
    deps: Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    devDeps: Object.fromEntries(
      Object.entries(manifest.devDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    optional: Object.fromEntries(
      Object.entries(manifest.optionalDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    peer: Object.fromEntries(
      Object.entries(manifest.peerDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    type: manifest.type ?? null,
  }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex')
}
