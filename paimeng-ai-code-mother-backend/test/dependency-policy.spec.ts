import { describe, expect, it } from 'vitest'
import { stableDependencyHash, validateManifest } from '../src/runtime/dependency-policy'

describe('dependency policy', () => {
  it('accepts whitelisted dependencies in valid ranges', () => {
    const result = validateManifest({ dependencies: { vue: '^3.5.0', vite: '^7.0.0' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.filtered?.dependencies).toEqual({ vue: '^3.5.0', vite: '^7.0.0' })
  })

  it('rejects unknown packages and protocols', () => {
    expect(validateManifest({ dependencies: { lodash: '^4.0.0' } }).ok).toBe(false)
    expect(validateManifest({ dependencies: { vue: 'file:../vue' } }).ok).toBe(false)
    expect(validateManifest({ dependencies: { vue: 'github:vuejs/core' } }).ok).toBe(false)
    expect(validateManifest({ dependencies: { vue: 'workspace:*' } }).ok).toBe(false)
  })

  it('rejects ranges outside the allowed range', () => {
    expect(validateManifest({ dependencies: { vue: '^2.7.0' } }).ok).toBe(false)
    expect(validateManifest({ dependencies: { vite: '^8.0.0' } }).ok).toBe(false)
  })

  it('checks every dependency field and strips scripts', () => {
    const result = validateManifest({
      dependencies: { vue: '^3.5.0' },
      devDependencies: { typescript: '~5.9.0' },
      optionalDependencies: { pinia: '^3.0.0' },
      peerDependencies: { react: '^19.1.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.filtered?.scripts).toEqual({ dev: 'vite', build: 'vite build' })
  })

  it('rejects reserved files and non-string versions', () => {
    expect(validateManifest({ dependencies: { vue: 3 as unknown as string } }).ok).toBe(false)
    expect(validateManifest({ packageManager: 'pnpm@12' }).ok).toBe(false)
  })

  it('produces stable hashes independent of key order', () => {
    const a = stableDependencyHash({ dependencies: { vue: '^3.5.0', vite: '^7.0.0' } })
    const b = stableDependencyHash({ dependencies: { vite: '^7.0.0', vue: '^3.5.0' } })
    expect(a).toBe(b)
  })
})
