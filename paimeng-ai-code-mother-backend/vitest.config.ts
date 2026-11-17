import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Real-service tests use node:test through the isolated root runner.
    include: ['test/*.spec.ts'],
  },
})
