import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { swapNodeModules } from '../src/runtime/dependency-swap'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'paimeng-swap-'))
  const nodeModules = join(root, 'node_modules')
  const staged = join(root, 'staging-node_modules')
  await mkdir(nodeModules, { recursive: true })
  await writeFile(join(nodeModules, 'marker'), 'old')
  await mkdir(staged, { recursive: true })
  await writeFile(join(staged, 'marker'), 'new')
  return { root, nodeModules, staged }
}

describe('dependency swap', () => {
  it('switches to the staged node_modules and removes the backup', async () => {
    const { root, nodeModules, staged } = await setup()
    const backup = join(root, 'backup')
    await swapNodeModules(nodeModules, staged, backup)
    expect(await readFile(join(nodeModules, 'marker'), 'utf8')).toBe('new')
  })

  it('restores the old node_modules when staged modules are missing', async () => {
    const { root, nodeModules } = await setup()
    const backup = join(root, 'backup')
    await expect(
      swapNodeModules(nodeModules, join(root, 'missing-node_modules'), backup),
    ).rejects.toThrow()
    expect(await readFile(join(nodeModules, 'marker'), 'utf8')).toBe('old')
  })
})
