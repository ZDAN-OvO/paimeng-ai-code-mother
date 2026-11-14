export type RunSnapshot = {
  runId: string
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
}

export type ChatRequest = { text: string; draft: string; clientRequestId: string }
export class ChatSubmissionRejected extends Error {}
type PendingMessage = Pick<ChatRequest, 'text' | 'draft'>
type RunEvent = { type: string; runId: string; payload: Record<string, unknown> }
export type ChatState = {
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'settling' | 'blocked'
  run: RunSnapshot | null
  pending: string | null
  canSubmit: boolean
  canStop: boolean
}

type Dependencies<E extends RunEvent> = {
  createRequestId: () => string
  beforeStart: () => Promise<unknown>
  start: (request: ChatRequest) => void
  accepted: (request: ChatRequest) => void
  stream: (request: ChatRequest, event: (event: E) => void, signal: AbortSignal) => Promise<void>
  lookup: (query: { runId?: string; clientRequestId?: string }) => Promise<RunSnapshot | null>
  cancel: (runId: string) => Promise<unknown>
  refresh: (run: RunSnapshot | null) => Promise<unknown>
  event: (event: E) => void
  changed: (state: ChatState) => void
  error: (error: Error) => void
  sleep?: (ms: number) => Promise<unknown>
  pollAttempts?: number
}

type Turn = {
  request?: ChatRequest
  run: RunSnapshot | null
  abort: AbortController
  streamDone: Promise<void>
  streamClosed: boolean
  accepted: boolean
  blocked: boolean
  rejected?: boolean
  finishing?: Promise<boolean>
}

export const isTerminalRun = (run: RunSnapshot | null): boolean =>
  !!run && ['completed', 'failed', 'cancelled'].includes(run.status)

export function createTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task)
      tail = next.catch(() => undefined)
      return next
    },
    async idle() {
      let current: Promise<unknown>
      do {
        current = tail
        await current
      } while (current !== tail)
    },
  }
}

export function createChatCoordinator<E extends RunEvent>(deps: Dependencies<E>) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const attempts = deps.pollAttempts ?? 20
  let active: Turn | null = null
  let pending: PendingMessage | null = null
  let transition: Promise<boolean> | null = null
  let disposed = false
  const owns = (turn: Turn) => !disposed && active === turn

  const publish = () => {
    if (disposed) return
    const phase: ChatState['phase'] = transition
      ? 'stopping'
      : !active
        ? 'idle'
        : active.blocked
          ? 'blocked'
          : active.finishing || isTerminalRun(active.run)
            ? 'settling'
            : active.accepted
              ? 'running'
              : 'starting'
    deps.changed({
      phase,
      run: active?.run ? { ...active.run } : null,
      pending: pending?.text ?? null,
      canSubmit: !transition && ['idle', 'running', 'blocked'].includes(phase),
      canStop: !!active && !transition,
    })
  }

  const report = (error: unknown) => {
    if (!disposed) deps.error(error instanceof Error ? error : new Error('请求失败，请重试'))
  }

  const accept = (turn: Turn) => {
    if (!turn.accepted && turn.request) {
      turn.accepted = true
      deps.accepted(turn.request)
    }
  }

  const lookup = async (turn: Turn) => {
    const found = await deps.lookup(
      turn.run ? { runId: turn.run.runId } : { clientRequestId: turn.request?.clientRequestId },
    )
    if (owns(turn) && found && !isTerminalRun(turn.run)) {
      turn.run = found
      accept(turn)
      publish()
    }
    return found
  }

  const confirmTerminal = async (turn: Turn): Promise<RunSnapshot | null> => {
    for (let i = 0; i < attempts && owns(turn); i++) {
      if (isTerminalRun(turn.run)) return turn.run
      try {
        const found = await lookup(turn)
        if (isTerminalRun(turn.run)) return turn.run
        if (!found && !turn.run && turn.streamClosed && turn.rejected) return null
      } catch {
        if (!owns(turn)) return null
      }
      if (i < attempts - 1) await sleep(500)
    }
    throw new Error('任务状态仍未确认，消息尚未发送，请重试停止')
  }

  const finish = (turn: Turn): Promise<boolean> => {
    if (turn.finishing) return turn.finishing
    turn.finishing = Promise.resolve().then(async () => {
      try {
        const terminal = await confirmTerminal(turn)
        if (!owns(turn)) return false
        if (!turn.streamClosed) turn.abort.abort()
        await turn.streamDone
        if (!owns(turn)) return false
        await deps.refresh(terminal)
        if (!owns(turn)) return false
        active = null
        return true
      } catch (error) {
        if (owns(turn)) {
          turn.blocked = true
          report(error)
        }
        return false
      } finally {
        turn.finishing = undefined
        publish()
      }
    })
    publish()
    return turn.finishing
  }

  const launch = (message: PendingMessage) => {
    const request: ChatRequest = { ...message, clientRequestId: deps.createRequestId() }
    const turn: Turn = {
      request,
      run: null,
      abort: new AbortController(),
      streamDone: Promise.resolve(),
      streamClosed: false,
      accepted: false,
      blocked: false,
    }
    active = turn
    pending = null
    deps.start(request)
    turn.streamDone = Promise.resolve()
      .then(() =>
        deps.stream(
          request,
          (event) => {
            if (!owns(turn) || isTerminalRun(turn.run)) return
            if (turn.run && turn.run.runId !== event.runId) return
            const status = event.type === 'run-finished' ? event.payload.status : 'running'
            if (
              !['running', 'cancelling', 'completed', 'failed', 'cancelled'].includes(
                String(status),
              )
            )
              return
            turn.run = {
              runId: event.runId,
              status:
                turn.run?.status === 'cancelling' && status === 'running'
                  ? 'cancelling'
                  : (status as RunSnapshot['status']),
            }
            accept(turn)
            deps.event(event)
            publish()
          },
          turn.abort.signal,
        ),
      )
      .catch((error) => {
        turn.rejected = error instanceof ChatSubmissionRejected
        if (owns(turn) && !turn.abort.signal.aborted) report(error)
      })
      .then(() => {
        turn.streamClosed = true
      })
    void turn.streamDone.then(() => {
      if (owns(turn)) void finish(turn)
    })
    publish()
  }

  const changeRun = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (transition) return transition
    transition = Promise.resolve().then(async () => {
      try {
        const turn = active
        if (turn) {
          if (!turn.run) await lookup(turn)
          if (disposed) return false
          if (owns(turn)) {
            if (!turn.run) throw new Error('正在确认任务，请稍后重试停止；待发消息已保留')
            if (!isTerminalRun(turn.run)) await deps.cancel(turn.run.runId)
            if (disposed) return false
            if (owns(turn) && !(await finish(turn))) return false
          }
        }
        if (disposed) return false
        if (pending) {
          await deps.beforeStart()
          if (disposed) return false
          launch(pending)
        }
        return true
      } catch (error) {
        if (active) active.blocked = true
        report(error)
        return false
      } finally {
        transition = null
        publish()
      }
    })
    publish()
    return transition
  }

  publish()
  return {
    submit(draft: string): Promise<boolean> {
      const text = draft.trim()
      if (disposed || transition || !text || text.length > 1000) return Promise.resolve(false)
      if (
        active &&
        !active.blocked &&
        (!active.accepted || active.finishing || isTerminalRun(active.run))
      )
        return Promise.resolve(false)
      pending = { text, draft }
      return changeRun()
    },
    stop: changeRun,
    restore(run: RunSnapshot) {
      if (disposed || active || transition) return
      const turn: Turn = {
        run,
        abort: new AbortController(),
        streamDone: Promise.resolve(),
        streamClosed: true,
        accepted: true,
        blocked: false,
      }
      active = turn
      publish()
      void (async () => {
        while (owns(turn) && !isTerminalRun(turn.run)) {
          await sleep(2000)
          if (!owns(turn)) return
          try {
            await lookup(turn)
          } catch {
            if (!owns(turn)) return
          }
        }
        if (owns(turn)) await finish(turn)
      })()
    },
    dispose() {
      disposed = true
      active?.abort.abort()
      pending = null
    },
  }
}
