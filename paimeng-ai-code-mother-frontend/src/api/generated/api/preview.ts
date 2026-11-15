// @ts-ignore
/* eslint-disable */
import request from '@/request'

/** 签发预览访问票据 POST /app/preview/access */
export async function requestPreviewAccess(body: API.AppIdDto, options?: { [key: string]: any }) {
  return request<API.BaseResponsePreviewAccess>('/app/preview/access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 续期预览访问授权 POST /app/preview/heartbeat */
export async function sendPreviewHeartbeat(body: API.AppIdDto, options?: { [key: string]: any }) {
  return request<API.BaseResponseBoolean>('/app/preview/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 启动或复用预览环境 POST /app/preview/start */
export async function startPreview(body: API.AppIdDto, options?: { [key: string]: any }) {
  return request<API.BaseResponsePreviewStart>('/app/preview/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 查询预览状态 GET /app/preview/status */
export async function getPreviewStatus(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getPreviewStatusParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponsePreviewStatus>('/app/preview/status', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}
