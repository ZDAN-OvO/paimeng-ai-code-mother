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
    const serialized = JSON.parse(JSON.stringify(schemas))
    expect(serialized.write.inputSchema).toMatchObject({
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    })
  })
})
