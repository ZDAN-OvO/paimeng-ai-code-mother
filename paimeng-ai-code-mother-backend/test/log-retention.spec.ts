import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pruneLogDir, truncateLogTail } from '../src/runtime/log-retention'

describe('log retention', () => {
  it('keeps the tail of an oversized log', () => {
    const result = truncateLogTail('header\nerror: last line', 10)
    expect(result).toBe(' last line')
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(10)
  })

  it('keeps newest files until the per-app byte budget is reached', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paimeng-logs-'))
    await writeFile(join(dir, 'old.log'), 'a'.repeat(10))
    await writeFile(join(dir, 'middle.log'), 'b'.repeat(10))
    await writeFile(join(dir, 'new.log'), 'c'.repeat(10))
    const now = Date.now() / 1000
    await utimes(join(dir, 'old.log'), now - 30, now - 30)
    await utimes(join(dir, 'middle.log'), now - 20, now - 20)
    await utimes(join(dir, 'new.log'), now, now)

    await pruneLogDir(dir, 25)
    const left = (await readdir(dir)).sort()
    expect(left).toEqual(['middle.log', 'new.log'])
  })
})
