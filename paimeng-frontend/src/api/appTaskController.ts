import request from '@/request'
import { API_BASE_URL } from '@/config/env'

export function createChatTask(data: API.CreateChatTaskRequest, signal?: AbortSignal) {
  return request.post<API.ChatTaskResponse<API.CreateChatTaskResult>>('/app/chat/tasks', data, {
    signal,
  })
}

export function getActiveChatTask(appId: string, signal?: AbortSignal) {
  return request.get<API.ChatTaskResponse<API.ActiveChatTask | null>>('/app/chat/tasks/active', {
    params: { appId },
    signal,
  })
}

export function buildTaskEventsUrl(taskId: string, lastEventId?: string) {
  const base = (request.defaults.baseURL || API_BASE_URL).replace(/\/$/, '')
  const path = `${base}/app/chat/tasks/${encodeURIComponent(taskId)}/events`
  if (!lastEventId) return path
  return `${path}?${new URLSearchParams({ lastEventId })}`
}
