import { describe, expect, it } from 'vitest'
import { evaluateRunLimits } from '../src/agent/run-limits'

const base = {
  cancelled: false,
  stepCount: 0,
  maxSteps: 100,
  now: 1_000_000,
  deadlineAt: 2_000_000,
  maxDurationMs: 30 * 60 * 1000,
}

describe('run limits', () => {
  it('allows work before the step and time boundaries', () => {
    expect(evaluateRunLimits({ ...base, stepCount: 99 })).toBeNull()
    expect(evaluateRunLimits({ ...base, now: base.deadlineAt })).toBeNull()
  })

  it('stops at the 100th model step', () => {
    const result = evaluateRunLimits({ ...base, stepCount: 100 })
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'STEP_LIMIT',
      errorSummary: '达到最大模型步数（100），任务已停止',
    })
  })

  it('stops after the total duration deadline', () => {
    const result = evaluateRunLimits({ ...base, now: base.deadlineAt + 1 })
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'RUN_TIMEOUT',
      errorSummary: '运行超过 30 分钟总时长限制，任务已停止',
    })
  })

  it('prioritizes cancellation', () => {
    expect(
      evaluateRunLimits({
        ...base,
        cancelled: true,
        stepCount: 100,
        now: base.deadlineAt + 1,
      }),
    ).toEqual({ status: 'cancelled' })
  })
})
