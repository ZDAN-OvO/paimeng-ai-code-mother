import type {
  ChatMode,
  ChatStreamEvent,
  ChatUIMessage,
  MessageQueueState,
  QueueItem,
} from '@/api/chatTypes'

export type ComposerAction = 'send' | 'stop' | 'disabled'
export type ComposerShortcut =
  | { type: 'submit'; mode: ChatMode }
  | { type: 'newline' }
  | { type: 'none' }

export type InitialPromptGate = {
  pending: boolean
  started: boolean
  initialized: boolean
  historyLoading: boolean
  historyConfirmed: boolean
  queueConfirmed: boolean
  messageCount: number
  paused: boolean
  activeRun: MessageQueueState['activeRun']
  queueItemCount: number
  initPrompt: string | undefined
}

export type EnqueueMessageBody = {
  appId: number
  message: string
  clientRequestId: string
  mode: ChatMode
  runId?: string
}

export type RunReconcileResult = {
  runId: string
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  errorSummary: string | null
}

export type QueuedChatDependencies<Event extends ChatStreamEvent = ChatStreamEvent> = {
  appId: number
  createRequestId: () => string
  enqueue: (body: EnqueueMessageBody) => Promise<QueueItem>
  getQueue: (appId: number) => Promise<MessageQueueState>
  findRunByRequest: (appId: number, clientRequestId: string) => Promise<RunReconcileResult>
  findQueueItemByRequest: (appId: number, clientRequestId: string) => Promise<QueueItem | null>
  remove: (appId: number, id: string) => Promise<void>
  resume: (appId: number) => Promise<MessageQueueState>
  cancel: (runId: string) => Promise<void>
  reconcile: (runId: string) => Promise<RunReconcileResult>
  subscribe: (
    runId: string,
    handlers: {
      onMessage: (message: ChatUIMessage) => void
      onEvent: (event: Event) => void
      onClose: () => void
    },
    signal: AbortSignal,
  ) => Promise<void>
  changed: (state: MessageQueueState) => void
  message: (runId: string, message: ChatUIMessage) => void
  event: (runId: string, event: Event) => void
  reconciled: (result: RunReconcileResult) => void
  error: (error: Error) => void
  pollMs?: number
}

const emptyQueue = (): MessageQueueState => ({ paused: false, items: [], activeRun: null })

const visibleQueueItem = (item: QueueItem) => item.status !== 'started' && item.status !== 'removed'

export function composerAction(text: string, hasActiveRun: boolean): ComposerAction {
  if (text.trim()) return 'send'
  return hasActiveRun ? 'stop' : 'disabled'
}

export function shouldStartInitialPrompt(input: InitialPromptGate): boolean {
  return (
    input.pending &&
    !input.started &&
    input.initialized &&
    !input.historyLoading &&
    input.historyConfirmed &&
    input.queueConfirmed &&
    input.messageCount === 0 &&
    !input.paused &&
    !input.activeRun &&
    input.queueItemCount === 0 &&
    Boolean(input.initPrompt)
  )
}

export function shouldPollQueue(state: MessageQueueState): boolean {
  if (state.activeRun) return true
  if (state.paused) return false
  return state.items.some((item) => item.status === 'queued' || item.status === 'claimed')
}

export function enqueueFingerprint(message: string, mode: ChatMode): string {
  return `${mode}\u0000${message}`
}

export function isUnknownEnqueueOutcome(error: unknown): boolean {
  const candidate = error as {
    knownOutcome?: boolean
    response?: { status?: number; data?: { code?: number } }
  } | null
  const status = candidate?.response?.status ?? 0
  const code = candidate?.response?.data?.code ?? 0
  if (status >= 500 || code >= 50000 || status === 408 || code === 40800) return true
  return !(
    (status >= 400 && status < 500) ||
    (code >= 40000 && code < 50000) ||
    candidate?.knownOutcome
  )
}

export function resolveComposerShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'> & { keyCode?: number },
  text: string,
  mode: ChatMode,
): ComposerShortcut {
  if (event.key !== 'Enter') return { type: 'none' }
  if (event.shiftKey) return { type: 'newline' }
  if (event.isComposing || event.keyCode === 229 || !text.trim()) return { type: 'none' }
  return { type: 'submit', mode: event.altKey ? (mode === 'steer' ? 'normal' : 'steer') : mode }
}

export function returnedItemDraft(currentDraft: string, item: QueueItem): string | null {
  if (item.status !== 'returned' || currentDraft.trim().length > 0) return null
  return item.message
}

export function draftAfterReturnedRemoval(
  originalDraft: string,
  returnedMessage: string,
  currentDraft: string,
  draftEdited: boolean,
): { draft: string | null; retainLocal: boolean } {
  if (draftEdited || currentDraft !== originalDraft) {
    return { draft: null, retainLocal: true }
  }
  return { draft: returnedMessage, retainLocal: false }
}

export function queueItemLabel(item: QueueItem): string {
  if (item.status === 'returned') return '已退回，可恢复草稿'
  if (item.mode === 'steer') return '插话发送 · 等待插入当前轮次'
  return item.status === 'claimed' ? '普通消息 · 即将发送' : '普通消息 · 排队中'
}

export function createQueuedChatCoordinator<Event extends ChatStreamEvent = ChatStreamEvent>(
  deps: QueuedChatDependencies<Event>,
) {
  let state = emptyQueue()
  let timer: ReturnType<typeof setTimeout> | null = null
  let refreshTask: Promise<MessageQueueState> | null = null
  let localGeneration = 0
  let transitionTask: Promise<MessageQueueState> = Promise.resolve(state)
  let subscription: { runId: string; controller: AbortController } | null = null
  let knownActiveRunId: string | null = null
  let queueConfirmed = false
  const unconfirmedEnqueues = new Map<string, { clientRequestId: string; runId?: string }>()
  const pendingNormalRequests = new Map<string, { runId: string | null; lookingUp: boolean }>()
  const recoveringRequests = new Set<string>()
  let disposed = false

  const publish = (next: MessageQueueState) => {
    state = next
    if (!disposed) deps.changed(state)
  }

  const clearPoll = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const schedulePoll = () => {
    clearPoll()
    const shouldPoll =
      !disposed &&
      (!queueConfirmed ||
        shouldPollQueue(state) ||
        [...pendingNormalRequests.values()].some((request) => request.lookingUp))
    if (!shouldPoll) return
    timer = setTimeout(() => {
      void refresh().catch(() => undefined)
    }, deps.pollMs ?? 1200)
  }

  const openSubscription = (runId: string) => {
    if (subscription?.runId === runId) return
    subscription?.controller.abort()
    const controller = new AbortController()
    subscription = { runId, controller }
    const acceptsEvents = () =>
      !disposed && subscription?.controller === controller && state.activeRun?.runId === runId
    void deps
      .subscribe(
        runId,
        {
          onMessage: (uiMessage) => {
            if (acceptsEvents()) deps.message(runId, uiMessage)
          },
          onEvent: (event) => {
            if (acceptsEvents()) deps.event(runId, event)
          },
          onClose: () => {
            if (acceptsEvents()) void refresh().catch(() => undefined)
          },
        },
        controller.signal,
      )
      .catch((error) => {
        if (!controller.signal.aborted && !disposed) deps.error(toError(error))
      })
      .finally(() => {
        if (subscription?.controller === controller) subscription = null
        if (!disposed) schedulePoll()
      })
  }

  const applyQueueState = async (next: MessageQueueState, generation: number) => {
    if (disposed || generation !== localGeneration) return state
    for (const item of next.items) {
      if (item.mode === 'normal' && (item.status === 'queued' || item.status === 'claimed')) {
        pendingNormalRequests.set(item.clientRequestId, { runId: item.runId, lookingUp: false })
      }
    }
    let reconciledRunId: string | null = null
    if (knownActiveRunId && knownActiveRunId !== next.activeRun?.runId) {
      const reconciled = await deps.reconcile(knownActiveRunId)
      if (disposed || generation !== localGeneration) return state
      if (reconciled.status === 'running' || reconciled.status === 'cancelling') {
        publish({
          ...next,
          activeRun: { runId: knownActiveRunId, status: reconciled.status },
        })
        openSubscription(knownActiveRunId)
        schedulePoll()
        return state
      }
      deps.reconciled(reconciled)
      reconciledRunId = reconciled.runId
      subscription?.controller.abort()
      subscription = null
      knownActiveRunId = null
    }

    const nextRunId = next.activeRun?.runId ?? null
    publish(next)
    if (nextRunId) {
      knownActiveRunId = nextRunId
      openSubscription(nextRunId)
    } else {
      knownActiveRunId = null
    }
    const confirmedState = state
    for (const [clientRequestId, request] of pendingNormalRequests) {
      const { runId } = request
      const item = next.items.find((entry) => entry.clientRequestId === clientRequestId)
      if (item?.status === 'queued' || item?.status === 'claimed') continue
      if (
        item?.status === 'returned' ||
        item?.status === 'removed' ||
        (runId && runId === next.activeRun?.runId)
      ) {
        pendingNormalRequests.delete(clientRequestId)
        continue
      }
      request.lookingUp = true
      if (recoveringRequests.has(clientRequestId)) continue
      recoveringRequests.add(clientRequestId)
      const isCurrent = () =>
        !disposed &&
        generation === localGeneration &&
        pendingNormalRequests.get(clientRequestId) === request
      void (async () => {
        try {
          const queued = await deps.findQueueItemByRequest(deps.appId, clientRequestId)
          if (!isCurrent()) return
          if (queued?.status === 'removed') {
            pendingNormalRequests.delete(clientRequestId)
            return
          }
          if (queued?.status === 'queued' || queued?.status === 'claimed') return
          const targetRunId = queued?.runId ?? runId
          const result = targetRunId
            ? await deps.reconcile(targetRunId)
            : await deps.findRunByRequest(deps.appId, clientRequestId)
          if (!isCurrent()) return
          if (result.status === 'running' || result.status === 'cancelling') {
            if (state.activeRun?.runId !== result.runId) {
              if (state !== confirmedState || state.activeRun) return
              knownActiveRunId = result.runId
              publish({ ...state, activeRun: { runId: result.runId, status: result.status } })
              openSubscription(result.runId)
            }
          } else if (result.runId !== reconciledRunId) {
            deps.reconciled(result)
          }
          pendingNormalRequests.delete(clientRequestId)
        } catch {
          return
        } finally {
          recoveringRequests.delete(clientRequestId)
          if (!disposed) schedulePoll()
        }
      })()
    }
    schedulePoll()
    return state
  }

  const ingest = (next: MessageQueueState) => {
    const generation = localGeneration
    transitionTask = transitionTask.then(
      () => applyQueueState(next, generation),
      () => applyQueueState(next, generation),
    )
    return transitionTask
  }

  const performRefresh = async () => {
    if (disposed) return state
    const generation = localGeneration
    const next = await deps.getQueue(deps.appId)
    if (disposed || generation !== localGeneration) return state
    queueConfirmed = true
    return ingest(next)
  }

  const refresh = (forceFresh = false): Promise<MessageQueueState> => {
    if (!forceFresh && refreshTask) return refreshTask
    const task = performRefresh().finally(() => {
      if (refreshTask === task) refreshTask = null
      if (!disposed) schedulePoll()
    })
    refreshTask = task
    return refreshTask
  }

  const enqueue = async (input: {
    appId: number
    message: string
    mode: ChatMode
    clientRequestId?: string
    runId?: string
  }) => {
    const fingerprint = enqueueFingerprint(input.message, input.mode)
    const pending = input.clientRequestId ? undefined : unconfirmedEnqueues.get(fingerprint)
    const clientRequestId =
      input.clientRequestId ?? pending?.clientRequestId ?? deps.createRequestId()
    const runId = pending ? pending.runId : (input.runId ?? state.activeRun?.runId)
    if (!input.clientRequestId) {
      unconfirmedEnqueues.set(fingerprint, { clientRequestId, runId })
    }
    const body: EnqueueMessageBody = {
      appId: input.appId,
      message: input.message,
      clientRequestId,
      mode: input.mode,
      ...(runId ? { runId } : {}),
    }
    let item: QueueItem
    try {
      item = await deps.enqueue(body)
      unconfirmedEnqueues.delete(fingerprint)
    } catch (error) {
      if (!isUnknownEnqueueOutcome(error)) {
        unconfirmedEnqueues.delete(fingerprint)
      }
      throw error
    }
    localGeneration += 1
    if (item.mode === 'normal' && ['queued', 'claimed', 'started'].includes(item.status)) {
      pendingNormalRequests.set(item.clientRequestId, { runId: item.runId, lookingUp: false })
    }
    if (visibleQueueItem(item)) {
      publish({ ...state, items: [...state.items.filter((entry) => entry.id !== item.id), item] })
    } else if (item.status === 'started' && item.runId) {
      await ingest({
        ...state,
        items: state.items.filter((entry) => entry.id !== item.id),
        activeRun: { runId: item.runId, status: 'running' },
      }).catch(() => deps.error(new Error('消息已接收，运行状态刷新失败')))
    }
    schedulePoll()
    await refresh(true).catch(() => {
      deps.error(new Error('消息已接收，队列状态刷新失败'))
    })
    return item
  }

  const remove = async (id: string) => {
    await deps.remove(deps.appId, id)
    localGeneration += 1
    const item = state.items.find((entry) => entry.id === id)
    if (item) pendingNormalRequests.delete(item.clientRequestId)
    publish({ ...state, items: state.items.filter((item) => item.id !== id) })
  }

  const resume = async () => {
    const next = await deps.resume(deps.appId)
    localGeneration += 1
    await ingest(next)
    return next
  }

  const stop = async () => {
    const active = state.activeRun
    if (!active) return false
    localGeneration += 1
    publish({
      ...state,
      activeRun: { ...active, status: 'cancelling' },
    })
    try {
      await deps.cancel(active.runId)
      return true
    } catch (error) {
      publish({ ...state, activeRun: active })
      throw error
    }
  }

  const observeActiveRun = (activeRun: NonNullable<MessageQueueState['activeRun']>) => {
    if (disposed) return
    localGeneration += 1
    publish({ ...state, activeRun })
    knownActiveRunId = activeRun.runId
    openSubscription(activeRun.runId)
    schedulePoll()
  }

  const dispose = () => {
    disposed = true
    clearPoll()
    subscription?.controller.abort()
    subscription = null
  }

  return {
    refresh,
    enqueue,
    remove,
    resume,
    stop,
    dispose,
    observeActiveRun,
    getState: () => state,
    isQueueConfirmed: () => queueConfirmed,
  }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error('消息队列连接中断')
}
