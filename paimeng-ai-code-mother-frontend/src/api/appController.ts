import request from '@/request'
import { API_BASE_URL } from '@/config/env'
import { ChatSubmissionRejected } from '@/utils/chatCoordinator'
import { chatStreamEventType } from '@/utils/chatStream'
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'

export async function addApp(body: API.AppAddRequest) {
  return request<API.BaseResponse<{ id: number }>>('/app/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

export async function listMyAppVoByPage(params: API.AppQueryRequest) {
  return request<API.BaseResponse<API.PageResult<API.AppVO>>>('/app/my/list/page/vo', {
    method: 'POST',
    data: {
      pageNum: params.pageNum ?? 1,
      pageSize: params.pageSize ?? 10,
      sortField: params.sortField ?? 'createTime',
      sortOrder: params.sortOrder ?? 'desc',
    },
  })
}

export async function getAppVoById(id: number | string) {
  return request<API.BaseResponse<API.AppVO>>('/app/get/vo', {
    method: 'GET',
    params: { id },
  })
}

export async function updateApp(body: API.AppUpdateRequest) {
  return request<API.BaseResponse<boolean>>('/app/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

export async function deleteApp(body: { id: number }) {
  return request<API.BaseResponse<boolean>>('/app/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

export async function getRunStatus(query: string | { appId: number; clientRequestId: string }) {
  return request<API.BaseResponse<API.RunStatus>>('/app/run/status', {
    method: 'GET',
    params: typeof query === 'string' ? { runId: query } : query,
  })
}

export async function getRunDetails(runId: string) {
  return request<API.BaseResponse<API.RunDetails>>('/app/run/details', {
    method: 'GET',
    params: { runId },
  })
}

export async function listRunActivities(runId: string, afterId?: number, limit = 200) {
  return request<API.BaseResponse<API.RunActivity[]>>('/app/run/activities', {
    method: 'GET',
    params: { runId, afterId, limit },
  })
}

export async function listRunChanges(runId: string, cursor?: number, limit = 100) {
  return request<API.BaseResponse<API.RunChangePage>>('/app/run/changes', {
    method: 'GET',
    params: { runId, cursor, limit },
  })
}

export async function getRunDiff(runId: string, fileId: number, cursor?: number, limit = 200) {
  return request<API.BaseResponse<API.RunDiffPage>>('/app/run/change', {
    method: 'GET',
    params: { runId, fileId, cursor, limit },
  })
}

export async function getValidationLog(runId: string, attempt: number, check: string) {
  return request<
    API.BaseResponse<{
      attempt: number
      check: string
      status: string
      summary: string | null
      logs: string | null
      truncated: boolean
    }>
  >('/app/run/validation/log', {
    method: 'GET',
    params: { runId, attempt, check },
  })
}

export async function cancelRun(runId: string) {
  return request<API.BaseResponse<{ runId: string; status: string }>>('/app/run/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { runId },
  })
}

export async function startPreview(appId: number) {
  return request<API.BaseResponse<{ status: string; error: string | null; url: string | null }>>(
    '/app/preview/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { appId },
    },
  )
}

export async function getPreviewStatus(appId: number) {
  return request<API.BaseResponse<API.AppPreview>>('/app/preview/status', {
    method: 'GET',
    params: { appId },
  })
}

export async function requestPreviewAccess(appId: number) {
  return request<API.BaseResponse<API.PreviewAccess>>('/app/preview/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { appId },
  })
}

export async function sendPreviewHeartbeat(appId: number) {
  return request<API.BaseResponse<boolean>>('/app/preview/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { appId },
  })
}

export interface ChatHandlers {
  onMessage: (message: API.ChatUIMessage) => void
  onEvent: (event: API.ChatStreamEvent) => void
  onClose: () => void
}

/**
 * 发送消息并以 SSE 流接收生成过程。
 * 使用 fetch 而不是 EventSource：消息体是 JSON，且需要携带同源 session cookie。
 */
export async function streamChat(
  body: { appId: number; message: string; clientRequestId: string },
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const transport = new DefaultChatTransport<UIMessage>({
    api: `${API_BASE_URL}/app/chat/gen/code`,
    credentials: 'include',
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      if (response.status === 401 && !window.location.pathname.includes('/user/login')) {
        window.location.href = `/user/login?redirect=${encodeURIComponent(window.location.href)}`
      }
      if (!response.ok) {
        let detail = `请求失败（HTTP ${response.status}）`
        try {
          const data = await response.clone().json()
          detail = data?.message || detail
        } catch {
          // 非 JSON 错误体
        }
        throw response.status >= 400 && response.status < 500
          ? new ChatSubmissionRejected(detail)
          : new Error(detail)
      }
      return response
    },
    prepareSendMessagesRequest: ({ body: requestBody }) => ({ body: requestBody ?? {} }),
  })
  const userMessage: API.ChatUIMessage = {
    id: `user:${body.clientRequestId}`,
    role: 'user',
    parts: [{ type: 'text', text: body.message, state: 'done' }],
  }
  try {
    const source = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: body.clientRequestId,
      messageId: userMessage.id,
      messages: [userMessage as unknown as UIMessage],
      body,
      abortSignal: signal,
    })
    const [forMessage, forEvents] = source.tee()
    let currentRunId = ''
    const events = (async () => {
      const reader = forEvents.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = value as unknown as API.ChatUIMessageChunk
        const data = chunk.data as Record<string, unknown> | undefined
        if (typeof data?.runId === 'string') currentRunId = data.runId
        if (
          typeof chunk.type === 'string' &&
          chunk.type.startsWith('data-') &&
          (currentRunId || data?.runId)
        ) {
          handlers.onEvent({
            runId: currentRunId || String(data?.runId),
            type: chatStreamEventType(chunk.type),
            payload: data ?? {},
          })
        }
      }
    })()
    const messages = (async () => {
      for await (const uiMessage of readUIMessageStream<UIMessage>({
        stream: forMessage as never,
      })) {
        handlers.onMessage(uiMessage as unknown as API.ChatUIMessage)
      }
    })()
    await Promise.all([events, messages])
    handlers.onClose()
  } catch (error) {
    if (signal.aborted) {
      handlers.onClose()
      return
    }
    throw error instanceof Error ? error : new Error('流式连接中断')
  }
}
