import request from '@/request'

export async function healthCheck() {
  return request<API.BaseResponse<{ status: string; uptimeSeconds: number }>>('/health', {
    method: 'GET',
  })
}
