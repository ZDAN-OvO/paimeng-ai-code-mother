import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

export function useTempDirs() {
  const paths: string[] = []
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })
  return async (prefix: string) => {
    const path = await mkdtemp(join(tmpdir(), prefix))
    paths.push(path)
    return path
  }
}
