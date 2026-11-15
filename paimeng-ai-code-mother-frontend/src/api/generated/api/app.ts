// @ts-ignore
/* eslint-disable */
import request from '@/request'

/** 创建应用 POST /app/add */
export async function addApp(body: API.AddAppDto, options?: { [key: string]: any }) {
  return request<API.BaseResponseAddApp>('/app/add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 删除应用 POST /app/delete */
export async function deleteApp(body: API.AppIdBodyDto, options?: { [key: string]: any }) {
  return request<API.BaseResponseBoolean>('/app/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 获取应用详情 GET /app/get/vo */
export async function getAppVoById(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getAppVoByIdParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseAppVO>('/app/get/vo', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 分页查询我的应用（兼容别名） GET /app/my/list/page */
export async function listMyAppByPage(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.listMyAppByPageParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseAppListPage>('/app/my/list/page', {
    method: 'GET',
    params: {
      ...params,
    },
    ...(options || {}),
  })
}

/** 分页查询我的应用 POST /app/my/list/page/vo */
export async function listMyAppVoByPage(
  body: API.ListAppQueryDto,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponseAppListPage>('/app/my/list/page/vo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 重命名应用 POST /app/update */
export async function updateApp(body: API.UpdateAppDto, options?: { [key: string]: any }) {
  return request<API.BaseResponseBoolean>('/app/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}
