import { useLoginUserStore } from '@/stores/loginUser'
import router from '@/router'

let firstFetchLoginUser = true

router.beforeEach(async () => {
  const loginUserStore = useLoginUserStore()
  if (firstFetchLoginUser) {
    try {
      await loginUserStore.fetchLoginUser()
    } finally {
      firstFetchLoginUser = false
    }
  }
  return true
})
