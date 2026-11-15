declare namespace API {
  type AddAppDto = {
    initPrompt: string
  }

  type AppIdBodyDto = {
    id: number
  }

  type AppIdDto = {
    appId: number
  }

  type BaseResponseAddApp = {
    code: number
    message: string
    data: { id: number }
  }

  type BaseResponseAppListPage = {
    code: number
    message: string
    data: {
      records: {
        id: number
        appName: string
        initPrompt: string
        codeGenType: 'static' | 'vue' | 'react' | null
        userId: number
        status: string
        createTime: string
        updateTime: string
        currentRun: {
          runId: string
          id: string
          status: 'running' | 'cancelling'
          phase: string
          stepCount: number
          repairCount: number
          startedAt: string
          deadlineAt: string
        } | null
        preview: {
          status: 'stopped' | 'starting' | 'running' | 'failed' | 'unavailable'
          kind: 'static' | 'vue' | 'react' | null
          url: string | null
          lastError: string | null
        }
      }[]
      total: number
      current: number
      pageSize: number
      pages: number
    }
  }

  type BaseResponseAppVO = {
    code: number
    message: string
    data: {
      id: number
      appName: string
      initPrompt: string
      codeGenType: 'static' | 'vue' | 'react' | null
      userId: number
      status: string
      createTime: string
      updateTime: string
      currentRun: {
        runId: string
        id: string
        status: 'running' | 'cancelling'
        phase: string
        stepCount: number
        repairCount: number
        startedAt: string
        deadlineAt: string
      } | null
      preview: {
        status: 'stopped' | 'starting' | 'running' | 'failed' | 'unavailable'
        kind: 'static' | 'vue' | 'react' | null
        url: string | null
        lastError: string | null
      }
    }
  }

  type BaseResponseBoolean = {
    code: number
    message: string
    data: boolean
  }

  type BaseResponseCancelRun = {
    code: number
    message: string
    data: { runId: string; status: string }
  }

  type BaseResponseChatHistory = {
    code: number
    message: string
    data: {
      records: {
        id: number
        runId: string | null
        role: 'user' | 'assistant'
        status: 'completed' | 'streaming' | 'failed' | 'cancelled'
        content: {
          id: string
          role: 'system' | 'user' | 'assistant'
          metadata?: Record<string, any>
          parts: (
            | { type: 'text'; text: string; state?: 'streaming' | 'done' }
            | {
                type: 'dynamic-tool'
                dynamic?: true
                toolName: string
                toolCallId: string
                state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
                input?: Record<string, any>
                output?: Record<string, any>
                errorText?: string
                title?: string
              }
            | {
                type: 'data-plan'
                id: string
                data: {
                  revision: number
                  steps: {
                    id: string
                    title: string
                    status: 'pending' | 'in_progress' | 'completed'
                  }[]
                }
              }
            | {
                type: 'data-validation'
                id: string
                data: {
                  attempt: number
                  check?: string
                  status: 'running' | 'passed' | 'failed' | 'skipped'
                  message?: string
                }
              }
          )[]
        }
        createTime: string
        updateTime: string
      }[]
      nextCursor: string | null
      hasMore: boolean
    }
  }

  type BaseResponseHealth = {
    code: number
    message: string
    data: { status: string; uptimeSeconds: number }
  }

  type BaseResponseLoginUserVO = {
    code: number
    message: string
    data: {
      id: number
      userAccount: string
      userName: string
      userAvatar: string | null
      userProfile: string | null
      userRole: string
      createTime: string
      updateTime: string
    }
  }

  type BaseResponsePreviewAccess = {
    code: number
    message: string
    data: { ticket: { ticket: string; expiresIn: number }; url: string; expiresInSeconds: number }
  }

  type BaseResponsePreviewStart = {
    code: number
    message: string
    data: {
      status: 'stopped' | 'starting' | 'running' | 'failed'
      error: string | null
      url: string | null
    }
  }

  type BaseResponsePreviewStatus = {
    code: number
    message: string
    data: {
      status: 'stopped' | 'starting' | 'running' | 'failed'
      kind: 'static' | 'vue' | 'react' | null
      url: string | null
      lastError: string | null
    }
  }

  type BaseResponseReadiness = {
    code: number
    message: string
    data: { status: string; checks: Record<string, any> }
  }

  type BaseResponseRunActivityList = {
    code: number
    message: string
    data: { id: number; type: string; payload: Record<string, any>; at: string }[]
  }

  type BaseResponseRunChangePage = {
    code: number
    message: string
    data: {
      records: {
        id: number
        path: string
        status: 'added' | 'modified' | 'deleted' | 'unchanged' | 'pending'
        additions: number | null
        deletions: number | null
        diffStatus: 'ready' | 'binary' | 'too_large' | 'error' | 'pending'
      }[]
      nextCursor: string | null
    }
  }

  type BaseResponseRunDetails = {
    code: number
    message: string
    data: {
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
      plan: {
        revision: number
        steps: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }[]
        updatedAt?: string
      } | null
      validations: {
        attempt: number
        check: string
        status: 'running' | 'passed' | 'failed' | 'skipped'
        summary: string | null
        truncated: boolean
      }[]
      activityWatermark: number
      changes: {
        filesChanged: number
        additions: number | null
        deletions: number | null
        complete: boolean
        partial: boolean
      }
    }
  }

  type BaseResponseRunDiffPage = {
    code: number
    message: string
    data: {
      fileId: number
      path: string
      status: string
      lines: string[]
      nextCursor: string | null
      complete: boolean
    }
  }

  type BaseResponseRunStatus = {
    code: number
    message: string
    data: {
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
  }

  type BaseResponseRunValidationLog = {
    code: number
    message: string
    data: {
      attempt: number
      check: string
      status: string
      summary: string | null
      logs: string | null
      truncated: boolean
    }
  }

  type CancelRunDto = {
    runId: string
  }

  type ChatDto = {
    appId: number
    message: string
    clientRequestId: string
  }

  type ChatUIMessage = {
    id: string
    role: 'system' | 'user' | 'assistant'
    metadata?: Record<string, any>
    parts: (
      | { type: 'text'; text: string; state?: 'streaming' | 'done' }
      | {
          type: 'dynamic-tool'
          dynamic?: true
          toolName: string
          toolCallId: string
          state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
          input?: Record<string, any>
          output?: Record<string, any>
          errorText?: string
          title?: string
        }
      | {
          type: 'data-plan'
          id: string
          data: {
            revision: number
            steps: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }[]
          }
        }
      | {
          type: 'data-validation'
          id: string
          data: {
            attempt: number
            check?: string
            status: 'running' | 'passed' | 'failed' | 'skipped'
            message?: string
          }
        }
    )[]
  }

  type getAppVoByIdParams = {
    id: number
  }

  type getPreviewStatusParams = {
    appId: number
  }

  type getRunDetailsParams = {
    runId: string
  }

  type getRunDiffParams = {
    runId: string
    fileId: number
    cursor?: number
    limit?: number
  }

  type getRunStatusParams = {
    runId?: string
    appId?: number
    clientRequestId?: string
  }

  type getValidationLogParams = {
    runId: string
    attempt: number
    check: string
  }

  type listAppChatHistoryParams = {
    appId: number
    cursor?: string
    pageSize?: number
  }

  type ListAppQueryDto = {
    pageNum?: number
    pageSize?: number
    sortField?: 'createTime' | 'updateTime' | 'id' | 'appName'
    sortOrder?: 'asc' | 'desc'
  }

  type listMyAppByPageParams = {
    pageNum?: number
    pageSize?: number
    sortField?: 'createTime' | 'updateTime' | 'id' | 'appName'
    sortOrder?: 'asc' | 'desc'
  }

  type listRunActivitiesParams = {
    runId: string
    afterId?: number
    limit?: number
  }

  type listRunChangesParams = {
    runId: string
    cursor?: number
    limit?: number
  }

  type LoginDto = {
    userAccount: string
    userPassword: string
  }

  type PhaseChunk = {
    type: 'data-phase'
    data: { runId: string; phase: string }
  }

  type RegisterDto = {
    userAccount: string
    userPassword: string
    checkPassword: string
  }

  type RunChunk = {
    type: 'data-run'
    data: {
      runId: string
      status: string
      errorCode?: string | null
      errorSummary?: string | null
      stepCount?: number
      repairCount?: number
      detailsStatus?: 'pending' | 'ready' | 'incomplete'
      detailsError?: string | null
      changes?: {
        filesChanged: number
        additions: number | null
        deletions: number | null
        complete: boolean
        partial: boolean
      } | null
    }
  }

  type RunStartedChunk = {
    type: 'data-run-started'
    data: { runId: string; status: string }
  }

  type UIMessagePart = {
    part:
      | { type: 'text'; text: string; state?: 'streaming' | 'done' }
      | {
          type: 'dynamic-tool'
          dynamic?: true
          toolName: string
          toolCallId: string
          state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
          input?: Record<string, any>
          output?: Record<string, any>
          errorText?: string
          title?: string
        }
      | {
          type: 'data-plan'
          id: string
          data: {
            revision: number
            steps: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }[]
          }
        }
      | {
          type: 'data-validation'
          id: string
          data: {
            attempt: number
            check?: string
            status: 'running' | 'passed' | 'failed' | 'skipped'
            message?: string
          }
        }
  }

  type UpdateAppDto = {
    id: number
    appName: string
  }
}
