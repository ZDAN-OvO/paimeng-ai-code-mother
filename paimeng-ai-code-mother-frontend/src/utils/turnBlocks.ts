import type { ActivityGroup, ToolStatus, ToolTimelineEntry } from './agentActivity.ts'
import { groupKindOf, groupStatusOf } from './agentActivity.ts'
import { describeTool } from './toolDisplay.ts'
import type {
  RunPlan,
  UIMessageSteerPart,
  UIMessageToolPart,
  UIMessageValidationPart,
} from '@/api/chatTypes'

export type TurnBlock =
  | { type: 'text'; key: string; text: string }
  | { type: 'tools'; key: string; group: ActivityGroup }
  | { type: 'plan'; key: string; plan: RunPlan }
  | { type: 'validation'; key: string; validation: UIMessageValidationPart['data'] }
  | { type: 'steer'; key: string; steer: UIMessageSteerPart['data'] }

export function visibleTurnBlocks(
  blocks: TurnBlock[],
  status: 'streaming' | 'completed' | 'failed' | 'cancelled',
  processExpanded: boolean,
): TurnBlock[] {
  if (processExpanded || status === 'streaming') return blocks

  const visible = new Set<number>()
  blocks.forEach((block, index) => {
    if (block.type === 'steer') visible.add(index)
  })

  let end = blocks.map((block) => block.type).lastIndexOf('text')
  const hasToolAfter = end >= 0 && blocks.slice(end + 1).some((block) => block.type === 'tools')
  if (hasToolAfter) end = -1
  if (end >= 0 && blocks[end].type === 'text') {
    let start = end
    while (start > 0 && blocks[start - 1].type === 'text') start -= 1
    for (let index = start; index <= end; index += 1) visible.add(index)
  }

  return blocks.filter((_, index) => visible.has(index))
}

export function toolEntryFromPart(
  part: UIMessageToolPart,
  fallback: ToolStatus,
): ToolTimelineEntry {
  const status: ToolStatus =
    part.state === 'output-available'
      ? 'done'
      : part.state === 'output-error'
        ? fallback === 'stopped'
          ? 'stopped'
          : part.errorText?.includes('取消')
            ? 'stopped'
            : 'failed'
        : 'running'
  return {
    id: part.toolCallId,
    tool: part.toolName,
    input: part.input,
    result: part.output,
    status,
    error: part.errorText,
    label: describeTool(part.toolName, part.input, status, part.output, part.errorText),
  }
}

export function buildTurnBlocks(
  parts: API.ChatUIMessage['parts'],
  terminalStatus: 'streaming' | 'completed' | 'failed' | 'cancelled',
): TurnBlock[] {
  const blocks: TurnBlock[] = []
  let tools: ToolTimelineEntry[] = []
  let toolsKey = ''
  const fallback: ToolStatus =
    terminalStatus === 'cancelled' ? 'stopped' : terminalStatus === 'failed' ? 'failed' : 'done'

  const flushTools = () => {
    if (!tools.length) return
    blocks.push({
      type: 'tools',
      key: toolsKey,
      group: {
        key: toolsKey,
        kind: groupKindOf(tools[0].tool),
        entries: tools,
        status: groupStatusOf(tools),
      },
    })
    tools = []
    toolsKey = ''
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type === 'text') {
      flushTools()
      blocks.push({ type: 'text', key: `text-${index}`, text: part.text })
      continue
    }
    if (part.type === 'dynamic-tool') {
      const entry = toolEntryFromPart(part, fallback)
      const kind = groupKindOf(entry.tool)
      if (tools.length && groupKindOf(tools[0].tool) !== kind) flushTools()
      if (!tools.length) toolsKey = `tools-${index}`
      tools.push(entry)
      continue
    }
    flushTools()
    if (part.type === 'data-plan') {
      blocks.push({ type: 'plan', key: `plan-${part.id}`, plan: part.data })
      continue
    }
    if (part.type === 'data-validation') {
      blocks.push({ type: 'validation', key: part.id, validation: part.data })
      continue
    }
    if (part.type === 'data-steer') {
      blocks.push({ type: 'steer', key: part.id, steer: part.data })
    }
  }
  flushTools()
  return blocks
}
