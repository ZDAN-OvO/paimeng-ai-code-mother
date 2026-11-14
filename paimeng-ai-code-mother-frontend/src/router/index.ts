import { createRouter, createWebHistory } from 'vue-router'
import HomePage from '@/pages/HomePage.vue'
import UserLoginPage from '@/pages/user/UserLoginPage.vue'
import UserRegisterPage from '@/pages/user/UserRegisterPage.vue'
import AppChatPage from '@/pages/app/AppChatPage.vue'
import AppEditPage from '@/pages/app/AppEditPage.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: '主页', component: HomePage },
    { path: '/user/login', name: '用户登录', component: UserLoginPage },
    { path: '/user/register', name: '用户注册', component: UserRegisterPage },
    { path: '/app/chat/:id', name: '应用对话', component: AppChatPage, meta: { workspace: true } },
    { path: '/app/edit/:id', name: '编辑应用', component: AppEditPage },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
