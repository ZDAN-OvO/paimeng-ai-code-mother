export type RunLimitResult =
  | { status: 'cancelled' }
  | { status: 'failed'; errorCode: 'STEP_LIMIT' | 'RUN_TIMEOUT'; errorSummary: string }
  | null

export interface RunLimitInput {
  cancelled: boolean
  stepCount: number
  maxSteps: number
  now: number
  deadlineAt: number
  maxDurationMs: number
}

export function evaluateRunLimits(input: RunLimitInput): RunLimitResult {
  if (input.cancelled) return { status: 'cancelled' }
  if (input.stepCount >= input.maxSteps) {
    return {
      status: 'failed',
      errorCode: 'STEP_LIMIT',
      errorSummary: `达到最大模型步数（${input.maxSteps}），任务已停止`,
    }
  }
  if (input.now > input.deadlineAt) {
    return {
      status: 'failed',
      errorCode: 'RUN_TIMEOUT',
      errorSummary: `运行超过 ${Math.round(input.maxDurationMs / 60_000)} 分钟总时长限制，任务已停止`,
    }
  }
  return null
}
