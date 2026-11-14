export interface PreviewRecycleInput {
  status: 'stopped' | 'starting' | 'running' | 'failed'
  kind: 'static' | 'vue' | 'react' | null
  hasRunningRun: boolean
  lastHeartbeat: number
  now: number
  idleMs: number
}

export function shouldRecyclePreview(input: PreviewRecycleInput): boolean {
  if (input.status !== 'running') return false
  if (input.kind === 'static') return false
  if (input.hasRunningRun) return false
  return input.now - input.lastHeartbeat > input.idleMs
}
