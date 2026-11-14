import { describe, expect, it } from 'vitest'
import {
  NO_CODE_NOTE,
  NO_CODE_SUMMARY,
  NO_REPAIR_NOTE,
  NO_REPAIR_SUMMARY,
  RunProgress,
} from '../src/agent/run-progress'

describe('run progress', () => {
  it('does not validate a text-only turn before any source change', () => {
    const progress = new RunProgress()

    expect(progress.onTextOnlyTurn()).toEqual({ action: 'prompt', note: NO_CODE_NOTE })
    expect(progress.onTextOnlyTurn()).toEqual({
      action: 'fail',
      errorCode: 'NO_CODE_PRODUCED',
      errorSummary: NO_CODE_SUMMARY,
    })
  })

  it('validates after a successful source mutation', () => {
    const progress = new RunProgress()
    progress.markMutated()

    expect(progress.onTextOnlyTurn()).toEqual({ action: 'validate' })
  })

  it('requires another mutation after a failed validation', () => {
    const progress = new RunProgress()
    progress.markMutated()
    expect(progress.onTextOnlyTurn()).toEqual({ action: 'validate' })

    expect(progress.onTextOnlyTurn()).toEqual({ action: 'prompt', note: NO_REPAIR_NOTE })
    expect(progress.onTextOnlyTurn()).toMatchObject({
      action: 'fail',
      errorCode: 'VALIDATION_FAILED',
      errorSummary: NO_REPAIR_SUMMARY,
    })
  })

  it('allows a later mutation to trigger validation again', () => {
    const progress = new RunProgress()
    progress.markMutated()
    expect(progress.onTextOnlyTurn()).toEqual({ action: 'validate' })
    expect(progress.onTextOnlyTurn()).toMatchObject({ action: 'prompt' })

    progress.markMutated()
    expect(progress.onTextOnlyTurn()).toEqual({ action: 'validate' })
  })
})
