// @ts-ignore
/* eslint-disable */
import request from '@/request'

/** 存活检查 GET /health */
export async function health(options?: { [key: string]: any }) {
  return request<API.HealthResult>('/health', {
    method: 'GET',
    ...(options || {}),
  })
}

/** 就绪检查 GET /health/ready */
export async function ready(options?: { [key: string]: any }) {
  return request<API.ReadinessResult>('/health/ready', {
    method: 'GET',
    ...(options || {}),
  })
}
