import request from '@/request'

export async function userRegister(body: { userAccount: string; userPassword: string; checkPassword: string }) {
  return request<API.BaseResponse<API.LoginUserVO>>('/user/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

export async function userLogin(body: { userAccount: string; userPassword: string }) {
  return request<API.BaseResponse<API.LoginUserVO>>('/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
}

export async function userLogout() {
  return request<API.BaseResponse<boolean>>('/user/logout', { method: 'POST' })
}

export async function getLoginUser() {
  return request<API.BaseResponse<API.LoginUserVO>>('/user/get/login', { method: 'GET' })
}
