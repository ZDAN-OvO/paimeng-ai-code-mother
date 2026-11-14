<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { ArrowUpOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useLoginUserStore } from '@/stores/loginUser'
import { addApp, listMyAppVoByPage } from '@/api/appController'
import AppCard from '@/components/AppCard.vue'

const router = useRouter()
const loginUserStore = useLoginUserStore()

const userPrompt = ref('')
const creating = ref(false)
const myApps = ref<API.AppVO[]>([])
const myAppsPage = reactive({ current: 1, pageSize: 6, total: 0 })
const appsLoaded = ref(false)
const appsError = ref('')

const examples = [
  {
    label: '个人博客',
    prompt: '创建一个现代的个人博客，包含文章列表、详情页、分类和搜索，支持响应式布局。',
  },
  {
    label: '企业官网',
    prompt: '设计一个专业的企业官网，包含公司介绍、产品服务、新闻和联系我们页面。',
  },
  {
    label: '在线商城',
    prompt: '构建一个在线商城，包含商品列表、筛选、购物车和订单管理，界面现代简洁。',
  },
  {
    label: '作品集',
    prompt: '制作一个作品展示网站，包含画廊、项目详情、个人简介和联系方式。',
  },
]

const setPrompt = (prompt: string) => {
  userPrompt.value = prompt
}

const createApp = async () => {
  const prompt = userPrompt.value.trim()
  if (!prompt) {
    message.warning('请先描述你想做的应用')
    return
  }
  if (!loginUserStore.loginUser.id) {
    message.warning('请先登录')
    await router.push('/user/login')
    return
  }
  if (creating.value) return
  creating.value = true
  try {
    const res = await addApp({ initPrompt: prompt })
    if (res.data.code === 0 && res.data.data) {
      await router.push({ path: `/app/chat/${res.data.data.id}`, query: { start: '1' } })
      return
    }
    message.error(res.data.message || '创建失败')
  } catch {
    message.error('创建失败，请重试')
  } finally {
    creating.value = false
  }
}

const loadMyApps = async () => {
  appsError.value = ''
  if (!loginUserStore.loginUser.id) {
    myApps.value = []
    myAppsPage.total = 0
    appsLoaded.value = true
    return
  }
  try {
    const res = await listMyAppVoByPage({
      pageNum: myAppsPage.current,
      pageSize: myAppsPage.pageSize,
      sortField: 'updateTime',
      sortOrder: 'desc',
    })
    if (res.data.code !== 0 || !res.data.data) throw new Error(res.data.message || '加载失败')
    myApps.value = res.data.data.records || []
    myAppsPage.total = res.data.data.total || 0
  } catch {
    appsError.value = '作品加载失败，请稍后重试'
  } finally {
    appsLoaded.value = true
  }
}

const viewChat = (appId: number) => {
  router.push(`/app/chat/${appId}`)
}

const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void createApp()
  }
}

onMounted(loadMyApps)
</script>

<template>
  <div id="homePage" class="home">
    <section class="hero">
      <p class="eyebrow">派蒙 AI 应用工坊</p>
      <h1>把一句话，变成能用的应用</h1>
      <p class="lede">描述你想做的页面，AI 会写代码、验证并打开实时预览。</p>

      <div class="composer">
        <textarea
          v-model="userPrompt"
          class="composer-input"
          :maxlength="1000"
          rows="4"
          placeholder="例如：做一个可以添加、勾选和删除任务的待办清单，中文界面"
          @keydown="handleComposerKeydown"
        ></textarea>
        <div class="composer-footer">
          <span class="composer-hint">{{ userPrompt.length }}/1000 · ⌘/Ctrl + Enter 创建</span>
          <a-button type="primary" size="large" :loading="creating" @click="createApp">
            <template #icon><ArrowUpOutlined /></template>
            开始创建
          </a-button>
        </div>
      </div>

      <div class="examples">
        <span class="examples-label">试试这些</span>
        <button
          v-for="example in examples"
          :key="example.label"
          class="example-chip"
          type="button"
          @click="setPrompt(example.prompt)"
        >
          {{ example.label }}
        </button>
      </div>
    </section>

    <section v-if="loginUserStore.loginUser.id" class="recent">
      <div class="section-head">
        <div>
          <h2>最近应用</h2>
          <p>继续上次的进度，或开始一个新的想法。</p>
        </div>
        <span v-if="myAppsPage.total" class="count">{{ myAppsPage.total }} 个应用</span>
      </div>

      <div v-if="!appsLoaded" class="skeleton-grid">
        <div v-for="index in 3" :key="index" class="skeleton-card"></div>
      </div>

      <div v-else-if="appsError" class="load-error">
        <p>{{ appsError }}</p>
        <a-button @click="loadMyApps">
          <template #icon><ReloadOutlined /></template>
          重试
        </a-button>
      </div>

      <div v-else-if="!myApps.length" class="empty-projects">
        <p class="empty-title">还没有应用</p>
        <p class="empty-desc">写一句话开始创作，生成的页面会出现在这里。</p>
      </div>

      <div v-else class="app-grid">
        <AppCard v-for="app in myApps" :key="app.id" :app="app" @view-chat="viewChat" />
      </div>

      <div v-if="myAppsPage.total > myAppsPage.pageSize" class="pagination-wrapper">
        <a-pagination
          v-model:current="myAppsPage.current"
          :page-size="myAppsPage.pageSize"
          :total="myAppsPage.total"
          :show-size-changer="false"
          :show-total="(total: number) => `共 ${total} 个应用`"
          @change="loadMyApps"
        />
      </div>
    </section>

    <section v-else class="guest-note">
      <p>登录后可以保存作品、继续修改，并在手机上查看生成结果。</p>
      <a-button type="primary" @click="router.push('/user/login')">登录 / 注册</a-button>
    </section>
  </div>
</template>

<style scoped>
.home {
  min-height: calc(100vh - 64px);
  background:
    radial-gradient(circle at 12% 0%, rgba(251, 214, 177, 0.34), transparent 32%),
    radial-gradient(circle at 88% 8%, rgba(235, 173, 149, 0.18), transparent 30%), var(--pm-page);
}

.hero,
.recent,
.guest-note {
  max-width: 1120px;
  margin: 0 auto;
  padding-left: 24px;
  padding-right: 24px;
}

.hero {
  padding-top: 76px;
  padding-bottom: 24px;
  text-align: center;
}

.eyebrow {
  margin: 0 0 14px;
  color: var(--pm-brand-strong);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.hero h1 {
  margin: 0;
  color: var(--pm-ink);
  font-size: clamp(36px, 5vw, 58px);
  line-height: 1.12;
  letter-spacing: -0.035em;
}

.lede {
  margin: 18px auto 0;
  max-width: 620px;
  color: var(--pm-ink-2);
  font-size: 16px;
  line-height: 1.7;
}

.composer {
  max-width: 780px;
  margin: 34px auto 0;
  background: var(--pm-surface);
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-xl);
  box-shadow: var(--pm-shadow-md);
  padding: 10px;
  text-align: left;
}

.composer-input {
  width: 100%;
  resize: vertical;
  min-height: 104px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--pm-ink);
  padding: 16px 18px;
  font-size: 16px;
  line-height: 1.7;
}

.composer-input::placeholder {
  color: var(--pm-ink-3);
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 8px 4px 18px;
}

.composer-hint {
  color: var(--pm-ink-3);
  font-size: 12px;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 22px;
}

.examples-label {
  color: var(--pm-ink-3);
  font-size: 12px;
  margin-right: 4px;
}

.example-chip {
  border: 1px solid var(--pm-line);
  background: rgba(255, 252, 247, 0.7);
  color: var(--pm-ink-2);
  border-radius: 999px;
  padding: 7px 13px;
  font-size: 13px;
  cursor: pointer;
}

.example-chip:hover {
  border-color: var(--pm-brand);
  color: var(--pm-brand-strong);
  background: var(--pm-surface);
}

.recent {
  padding-top: 56px;
  padding-bottom: 80px;
}

.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.section-head h2 {
  margin: 0;
  font-size: 24px;
  letter-spacing: -0.02em;
}

.section-head p {
  margin: 6px 0 0;
  color: var(--pm-ink-2);
  font-size: 14px;
}

.count {
  color: var(--pm-ink-3);
  font-size: 13px;
}

.app-grid,
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.skeleton-card {
  height: 238px;
  border-radius: var(--pm-radius-lg);
  background: linear-gradient(100deg, var(--pm-surface-strong), #fff9f2, var(--pm-surface-strong));
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

.empty-projects,
.load-error {
  border: 1px dashed var(--pm-line-strong);
  border-radius: var(--pm-radius-lg);
  padding: 48px 24px;
  text-align: center;
  background: rgba(255, 252, 247, 0.58);
}

.empty-title,
.load-error p {
  margin: 0 0 8px;
  color: var(--pm-ink);
  font-size: 16px;
  font-weight: 600;
}

.empty-desc {
  margin: 0;
  color: var(--pm-ink-3);
  font-size: 14px;
}

.load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}

.guest-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
  margin-bottom: 80px;
  padding-top: 22px;
  padding-bottom: 22px;
  border-top: 1px solid var(--pm-line);
  color: var(--pm-ink-2);
  font-size: 14px;
}

.guest-note p {
  margin: 0;
}

@media (max-width: 900px) {
  .app-grid,
  .skeleton-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .hero {
    padding-top: 48px;
  }

  .app-grid,
  .skeleton-grid {
    grid-template-columns: 1fr;
  }

  .section-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .guest-note {
    flex-direction: column;
    align-items: flex-start;
  }

  .composer-footer {
    align-items: flex-end;
    flex-direction: column;
  }
}
</style>
