import request from '@/request'

export async function listAppChatHistory(params: { appId: number | string; cursor?: string; pageSize?: number }) {
  const { appId, ...query } = params
  return request<API.BaseResponse<API.ChatHistory>>(`/chatHistory/app/${appId}`, {
    method: 'GET',
    params: { pageSize: 20, ...query },
  })
}
