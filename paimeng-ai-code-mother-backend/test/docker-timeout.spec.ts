import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfigService } from '../src/config/config.module'
import { DockerService } from '../src/runtime/docker.service'

describe('docker task timeout', () => {
  it('kills a hanging docker CLI command when the timeout expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paimeng-docker-timeout-'))
    const script = join(root, 'sleep-docker.sh')
    await writeFile(script, '#!/bin/sh\nexec sleep 5\n')
    await chmod(script, 0o755)

    const previous = process.env.DOCKER_BIN
    process.env.DOCKER_BIN = script
    try {
      const service = new DockerService({} as AppConfigService)
      const started = Date.now()
      const result = await service.run(['wait', 'test'], { timeoutMs: 100 })
      expect(result.timedOut).toBe(true)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      if (previous === undefined) delete process.env.DOCKER_BIN
      else process.env.DOCKER_BIN = previous
    }
  })
})
