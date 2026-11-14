<template>
  <header class="header">
    <div class="header-inner">
      <RouterLink to="/" class="brand">
        <img class="logo" src="@/assets/logo-paimeng.png" alt="派蒙 AI 应用工坊" />
        <span class="site-title">派蒙 AI 应用工坊</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/" class="nav-link" :class="{ active: route.path === '/' }"
          >主页</RouterLink
        >
      </nav>

      <div class="user-login-status">
        <a-dropdown v-if="loginUser.id">
          <button class="user-button" type="button">
            <a-avatar :src="loginUser.userAvatar" :size="30">
              {{ (loginUser.userName || '派').slice(0, 1) }}
            </a-avatar>
            <span class="user-name">{{ loginUser.userName || '无名' }}</span>
          </button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="doLogout">
                <LogoutOutlined />
                退出登录
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-button v-else type="primary" href="/user/login">登录</a-button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { LogoutOutlined } from '@ant-design/icons-vue'
import { useLoginUserStore } from '@/stores/loginUser.ts'
import { userLogout } from '@/api/userController.ts'

const loginUserStore = useLoginUserStore()
const loginUser = computed(() => loginUserStore.loginUser)
const route = useRoute()
const router = useRouter()

const doLogout = async () => {
  const res = await userLogout()
  if (res.data.code === 0) {
    loginUserStore.setLoginUser({ userName: '未登录' })
    message.success('退出登录成功')
    await router.push('/user/login')
    return
  }
  message.error('退出登录失败，' + res.data.message)
}
</script>

<style scoped>
.header {
  height: 64px;
}

.header-inner {
  height: 64px;
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 24px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.logo {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  object-fit: cover;
  flex: 0 0 auto;
  box-shadow: 0 0 0 1px rgba(29, 28, 28, 0.08);
}

.site-title {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--pm-ink);
  white-space: nowrap;
}

.nav {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-link {
  padding: 8px 12px;
  border-radius: 999px;
  color: var(--pm-ink-2);
  text-decoration: none;
  font-size: 14px;
}

.nav-link:hover {
  background: var(--pm-surface-strong);
  color: var(--pm-ink);
}

.nav-link.active {
  background: var(--pm-canvas);
  color: var(--pm-brand-strong);
  font-weight: 600;
}

.user-login-status {
  display: flex;
  align-items: center;
}

.user-button {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 999px;
  padding: 4px 8px 4px 4px;
  cursor: pointer;
  color: var(--pm-ink);
}

.user-button:hover {
  background: var(--pm-surface-strong);
  border-color: var(--pm-line);
}

.user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

@media (max-width: 720px) {
  .header-inner {
    gap: 12px;
  }

  .site-title {
    font-size: 16px;
  }

  .nav {
    display: none;
  }

  .logo {
    width: 44px;
    height: 44px;
  }
}
</style>
