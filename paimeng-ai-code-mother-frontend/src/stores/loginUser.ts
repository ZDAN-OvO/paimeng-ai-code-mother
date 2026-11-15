import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LoginUserVO } from '@/api/apiTypes'
import { getLoginUser } from '@/api/generated/api/user'

/**
 * 登录用户信息
 */
export const useLoginUserStore = defineStore('loginUser', () => {
  // 默认值
  const loginUser = ref<Partial<LoginUserVO>>({
    userName: '未登录',
  })

  // 获取登录用户信息
  async function fetchLoginUser() {
    try {
      const res = await getLoginUser()
      if (res.data.code === 0 && res.data.data) {
        loginUser.value = res.data.data
      } else {
        loginUser.value = { userName: '未登录' }
      }
    } catch {
      loginUser.value = { userName: '未登录' }
    }
  }

  // 更新登录用户信息
  function setLoginUser(newLoginUser: Partial<LoginUserVO>) {
    loginUser.value = newLoginUser
  }

  return { loginUser, fetchLoginUser, setLoginUser }
})
