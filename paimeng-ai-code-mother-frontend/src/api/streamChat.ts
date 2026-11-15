import { API_BASE_URL } from '@/config/env'
import { ChatSubmissionRejected } from '@/utils/chatCoordinator'
import { assistantMessageId, chatStreamEventType } from '@/utils/chatStream'
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'
import type { ChatStreamEvent, ChatUIMessage, ChatUIMessageChunk } from './chatTypes'

export interface ChatHandlers {
  onMessage: (message: ChatUIMessage) => void
  onEvent: (event: ChatStreamEvent) => void
  onClose: () => void
}

export interface RunSubscriptionHandlers {
  onMessage: (message: ChatUIMessage) => void
  onEvent: (event: ChatStreamEvent) => void
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
  const userMessage: ChatUIMessage = {
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
        const chunk = value as unknown as ChatUIMessageChunk
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
        handlers.onMessage(uiMessage as unknown as ChatUIMessage)
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

/**
 * 订阅指定运行的完整 UIMessage 重放。每次收到的消息都是当前快照，调用方必须按 id 覆盖。
 */
export async function subscribeRunChat(
  body: { runId: string },
  handlers: RunSubscriptionHandlers,
  signal: AbortSignal,
): Promise<void> {
  const transport = new DefaultChatTransport<UIMessage>({
    api: `${API_BASE_URL}/app/run/stream`,
    credentials: 'include',
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      if (response.status === 401 && !window.location.pathname.includes('/user/login')) {
        window.location.href = `/user/login?redirect=${encodeURIComponent(window.location.href)}`
      }
      if (!response.ok) {
        let detail = `订阅失败（HTTP ${response.status}）`
        try {
          const data = await response.clone().json()
          detail = data?.message || detail
        } catch {
          // 非 JSON 错误体
        }
        throw new Error(detail)
      }
      return response
    },
    prepareSendMessagesRequest: ({ body: requestBody }) => ({ body: requestBody ?? {} }),
  })

  try {
    const source = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: assistantMessageId(body.runId),
      messageId: assistantMessageId(body.runId),
      messages: [] as UIMessage[],
      body,
      abortSignal: signal,
    })
    const [forMessage, forEvents] = source.tee()
    const events = (async () => {
      const reader = forEvents.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = value as unknown as ChatUIMessageChunk
        const data = chunk.data as Record<string, unknown> | undefined
        if (typeof chunk.type === 'string' && chunk.type.startsWith('data-')) {
          handlers.onEvent({
            runId: body.runId,
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
        handlers.onMessage({
          ...(uiMessage as unknown as ChatUIMessage),
          id: assistantMessageId(body.runId),
          role: 'assistant',
        })
      }
    })()
    await Promise.all([events, messages])
    if (!signal.aborted) handlers.onClose()
  } catch (error) {
    if (signal.aborted) return
    throw error instanceof Error ? error : new Error('运行订阅中断')
  }
}
