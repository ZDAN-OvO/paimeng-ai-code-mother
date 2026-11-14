import { describe, expect, it } from 'vitest'
import { ToolRegistryService } from '../src/tools/tool-registry.service'

describe('tool registry', () => {
  it('serializes tool schemas for conservative context budgeting', () => {
    const registry = new ToolRegistryService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const schemas = registry.modelToolSchemas()
    expect(Object.keys(schemas)).toContain('write')
    expect(schemas.load_skill.inputSchema).toBeTruthy()
    expect(JSON.stringify(schemas)).toContain('load_skill')
  })
})
