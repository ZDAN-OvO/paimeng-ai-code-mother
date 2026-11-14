declare namespace API {
  type BaseResponse<T> = {
    code: number
    message: string
    data: T
  }

  type PageResult<T> = {
    records: T[]
    total: number
    current: number
    pageSize: number
    pages: number
  }

  type LoginUserVO = {
    id: number
    userAccount: string
    userName: string
    userAvatar?: string | null
    userProfile?: string | null
    userRole: string
    createTime: string
    updateTime: string
  }

  type AppPreview = {
    status: 'stopped' | 'starting' | 'running' | 'failed'
    kind: 'static' | 'vue' | 'react' | null
    url: string | null
    lastError: string | null
  }

  type RunStatus = {
    runId: string
    appId: number
    status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
    phase: string
    stepCount: number
    repairCount: number
    errorCode: string | null
    errorSummary: string | null
    detailsStatus?: 'pending' | 'ready' | 'incomplete'
    detailsError?: string | null
    startedAt: string
    deadlineAt: string
    finishedAt: string | null
  }

  type CurrentRun = {
    runId: string
    id: string
    status: 'running' | 'cancelling'
    phase: string
    stepCount: number
    repairCount: number
    startedAt: string
    deadlineAt: string
  }

  type AppVO = {
    id: number
    appName: string
    initPrompt: string
    codeGenType: string | null
    userId: number
    status: string
    createTime: string
    updateTime: string
    currentRun: CurrentRun | null
    preview: AppPreview
  }

  type UIMessageTextPart = {
    type: 'text'
    text: string
    state?: 'streaming' | 'done'
  }

  type UIMessageToolPart = {
    type: 'dynamic-tool'
    dynamic: true
    toolName: string
    toolCallId: string
    state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
    input?: Record<string, unknown>
    output?: Record<string, unknown>
    errorText?: string
    title?: string
  }

  type UIMessagePlanPart = {
    type: 'data-plan'
    id: string
    data: {
      revision: number
      steps: RunPlanStep[]
    }
  }

  type UIMessageValidationPart = {
    type: 'data-validation'
    id: string
    data: {
      attempt: number
      check?: string
      status: 'running' | 'passed' | 'failed' | 'skipped'
      message?: string
    }
  }

  type UIMessagePart =
    | UIMessageTextPart
    | UIMessageToolPart
    | UIMessagePlanPart
    | UIMessageValidationPart

  type ChatUIMessage = {
    id: string
    role: 'system' | 'user' | 'assistant'
    metadata?: unknown
    parts: UIMessagePart[]
  }

  type ChatUIMessageChunk = {
    type: string
    [key: string]: unknown
  }

  type MessageVO = {
    id: number
    runId: string | null
    role: 'user' | 'assistant'
    status: 'completed' | 'streaming' | 'failed' | 'cancelled'
    content: ChatUIMessage
    createTime: string
    updateTime: string
  }

  type ChatHistory = {
    records: MessageVO[]
    nextCursor: string | null
    hasMore: boolean
  }

  type UserLoginRequest = {
    userAccount: string
    userPassword: string
  }

  type UserRegisterRequest = {
    userAccount: string
    userPassword: string
    checkPassword: string
  }

  type AppAddRequest = {
    initPrompt: string
  }

  type AppUpdateRequest = {
    id: number
    appName: string
  }

  type AppQueryRequest = {
    pageNum?: number
    pageSize?: number
    sortField?: string
    sortOrder?: string
  }

  type PreviewAccess = {
    ticket: {
      ticket: string
      expiresIn: number
    }
    url: string
    expiresInSeconds: number
  }

  type ChatStreamEvent = {
    runId: string
    type: string
    payload: Record<string, unknown>
  }

  type RunPlanStep = {
    id: string
    title: string
    status: 'pending' | 'in_progress' | 'completed'
  }

  type RunPlan = {
    revision: number
    steps: RunPlanStep[]
    updatedAt?: string
  }

  type RunValidation = {
    attempt: number
    check: string
    status: 'running' | 'passed' | 'failed' | 'skipped'
    summary: string | null
    truncated: boolean
  }

  type RunDetails = {
    runId: string
    appId: number
    status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
    phase: string
    stepCount: number
    repairCount: number
    startedAt: string | null
    deadlineAt: string | null
    finishedAt: string | null
    errorCode: string | null
    errorSummary: string | null
    detailsStatus: 'pending' | 'ready' | 'incomplete'
    detailsError: string | null
    plan: RunPlan | null
    validations: RunValidation[]
    activityWatermark: number
    changes: {
      filesChanged: number
      additions: number | null
      deletions: number | null
      complete: boolean
      partial: boolean
    }
  }

  type RunActivity = {
    id: number
    type: string
    payload: Record<string, unknown>
    at: string
  }

  type RunChange = {
    id: number
    path: string
    status: 'added' | 'modified' | 'deleted' | 'unchanged' | 'pending'
    additions: number | null
    deletions: number | null
    diffStatus: 'ready' | 'binary' | 'too_large' | 'error' | 'pending'
  }

  type RunChangePage = {
    records: RunChange[]
    nextCursor: string | null
  }

  type RunDiffPage = {
    fileId: number
    path: string
    status: string
    lines: string[]
    nextCursor: string | null
    complete: boolean
  }
}
