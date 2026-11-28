<script setup lang="ts">
import { useRoute } from 'vue-router'
import { LogoutOutlined, UserOutlined } from '@ant-design/icons-vue'
import { useLoginUserStore } from '@/stores/loginUser'

defineEmits<{ logout: [] }>()
const route = useRoute()
const store = useLoginUserStore()
</script>

<template>
  <header class="home-header">
    <div class="home-navigation">
      <RouterLink class="wordmark" to="/"> <span aria-hidden="true">✱</span> Paimeng </RouterLink>
      <nav class="view-switch" aria-label="主导航">
        <RouterLink to="/" :class="{ selected: !route.hash }">首页</RouterLink>
        <RouterLink to="/#my-works" :class="{ selected: route.hash === '#my-works' }">
          工作区
        </RouterLink>
      </nav>
      <a-dropdown v-if="store.loginUser.id" :trigger="['click']" placement="bottomRight">
        <button
          type="button"
          class="profile"
          :aria-label="'账户 ' + (store.loginUser.userName ?? '无名')"
        >
          <a-avatar :size="30" class="profile-avatar" :src="store.loginUser.userAvatar">
            {{ store.loginUser.userName?.charAt(0) || 'U' }}
          </a-avatar>
          <span class="profile-name">{{ store.loginUser.userName ?? '无名' }}</span>
        </button>
        <template #overlay>
          <a-menu>
            <template v-if="store.loginUser.userRole === 'admin'">
              <a-menu-item key="users"
                ><RouterLink to="/admin/userManage">用户管理</RouterLink></a-menu-item
              >
              <a-menu-item key="apps"
                ><RouterLink to="/admin/appManage">应用管理</RouterLink></a-menu-item
              >
              <a-menu-divider />
            </template>
            <a-menu-item key="logout" @click="$emit('logout')"
              ><LogoutOutlined /> 退出登录</a-menu-item
            >
          </a-menu>
        </template>
      </a-dropdown>
      <RouterLink v-else class="profile" to="/user/login"><UserOutlined aria-hidden="true" /> 登录</RouterLink>
    </div>
  </header>
</template>

<style scoped>
.home-header {
  border-bottom: 1px solid var(--line);
}
.home-navigation {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  max-width: 1360px;
  min-height: 66px;
  margin-inline: auto;
  padding-inline: 32px;
}
.wordmark,
.profile {
  display: flex;
  align-items: center;
  color: var(--ink);
}
.wordmark {
  gap: 10px;
  justify-self: start;
  font-size: 23px;
  font-weight: 700;
  letter-spacing: -0.95px;
}
.wordmark span {
  font-size: 27px;
  line-height: 1;
}
.view-switch {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--slot);
}
.view-switch a {
  min-width: 64px;
  padding: 4px 13px;
  border-radius: 6px;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
  white-space: nowrap;
}
.view-switch a:hover {
  color: var(--ink);
}
.view-switch .selected {
  color: var(--ink);
  background: var(--white);
  box-shadow: 0 1px 2px #18181b0d;
  font-weight: 600;
}
.profile {
  gap: 9px;
  justify-self: end;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
}
.profile-avatar {
  flex: none;
  color: #554b3c;
  background: #edeae1;
  border: 1px solid #e3e0d8;
  font-size: 12px;
}
.profile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 540px) {
  .home-navigation {
    min-height: 58px;
    padding-inline: 15px;
  }
  .wordmark {
    gap: 5px;
    font-size: 17px;
  }
  .wordmark span {
    font-size: 20px;
  }
  .profile-name {
    display: none;
  }
  .view-switch a {
    min-width: 49px;
    padding-inline: 7px;
  }
}
</style>
