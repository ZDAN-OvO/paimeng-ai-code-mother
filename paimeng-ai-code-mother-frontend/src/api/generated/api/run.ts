// @ts-ignore
/* eslint-disable */
import request from '@/request'

/** 发送消息并流式返回 Agent 输出 POST /app/chat/gen/code */
export async function chat(body: API.ChatDto, options?: { [key: string]: any }) {
  return request<string>('/app/chat/gen/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 查询待发送消息、未生效插话和当前运行 GET /app/chat/queue */
export async function getMessageQueue(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getMessageQueueParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseMessageQueue>('/app/chat/queue', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 将普通消息或插话加入发送队列 POST /app/chat/queue */
export async function enqueueMessage(
  body: API.EnqueueMessageDto,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseQueueItem>('/app/chat/queue', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 移除尚未处理的排队消息 POST /app/chat/queue/remove */
export async function removeQueuedMessage(
  body: API.RemoveQueuedMessageDto,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseMessageQueue>('/app/chat/queue/remove', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 继续普通消息队列 POST /app/chat/queue/resume */
export async function resumeMessageQueue(
  body: API.ResumeMessageQueueDto,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseMessageQueue>('/app/chat/queue/resume', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 分页读取运行活动 GET /app/run/activities */
export async function listRunActivities(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.listRunActivitiesParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunActivityList>('/app/run/activities', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 取消运行 POST /app/run/cancel */
export async function cancelRun(body: API.CancelRunDto, options?: { [key: string]: any }) {
  return request<API.BaseResponseCancelRun>('/app/run/cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 读取单文件变更 diff GET /app/run/change */
export async function getRunDiff(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getRunDiffParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunDiffPage>('/app/run/change', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 分页读取运行变更 GET /app/run/changes */
export async function listRunChanges(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.listRunChangesParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunChangePage>('/app/run/changes', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 获取运行详情 GET /app/run/details */
export async function getRunDetails(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getRunDetailsParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunDetails>('/app/run/details', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 查询运行状态 GET /app/run/status */
export async function getRunStatus(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getRunStatusParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunStatus>('/app/run/status', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 订阅运行输出，断开订阅不停止运行 POST /app/run/stream */
export async function subscribeRun(body: API.CancelRunDto, options?: { [key: string]: any }) {
  return request<string>('/app/run/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 读取验证日志 GET /app/run/validation/log */
export async function getValidationLog(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getValidationLogParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseRunValidationLog>('/app/run/validation/log', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}
