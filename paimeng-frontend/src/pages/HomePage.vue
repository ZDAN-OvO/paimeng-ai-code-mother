<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import {
  AppstoreOutlined,
  ArrowUpOutlined,
  BankOutlined,
  EditOutlined,
  PictureOutlined,
  PlusOutlined,
  ShoppingOutlined,
} from '@ant-design/icons-vue'
import { useLoginUserStore } from '@/stores/loginUser'
import { addApp, listMyAppVoByPage, listGoodAppVoByPage } from '@/api/appController'
import AppCard from '@/components/AppCard.vue'

const router = useRouter()
const loginStore = useLoginUserStore()
const promptInput = ref<HTMLTextAreaElement>()
const userPrompt = ref('')
const creating = ref(false)

const myWorks = reactive({
  records: [] as API.AppVO[],
  page: 1,
  total: 0,
  loading: false,
  error: false,
})
const featured = reactive({
  records: [] as API.AppVO[],
  page: 1,
  total: 0,
  loading: false,
  error: false,
})
const pageSize = 6
const examples = [
  {
    label: '个人博客网站',
    icon: EditOutlined,
    prompt: '创建一个个人博客网站，包含文章列表、详情页、分类和个人简介。',
  },
  {
    label: '企业官网',
    icon: BankOutlined,
    prompt: '设计一个企业官网，包含公司介绍、产品服务、客户案例和联系方式。',
  },
  {
    label: '在线商城',
    icon: ShoppingOutlined,
    prompt: '搭建一个在线商城，展示商品分类、商品详情和购物车。',
  },
  {
    label: '作品展示网站',
    icon: PictureOutlined,
    prompt: '制作一个设计师作品展示网站，包含作品画廊、项目详情和联系方式。',
  },
]

function focusPrompt() {
  promptInput.value?.focus()
}

function setPrompt(prompt: string) {
  userPrompt.value = prompt
  focusPrompt()
}

async function createApp() {
  if (creating.value) return
  const prompt = userPrompt.value.trim()
  if (!prompt) {
    focusPrompt()
    message.warning('请输入应用描述')
    return
  }
  if (!loginStore.loginUser.id) {
    await router.push('/user/login')
    return
  }

  creating.value = true
  try {
    const res = await addApp({ initPrompt: prompt })
    if (res.data.code !== 0 || !res.data.data) {
      throw new Error(res.data.message || '创建失败，请重试')
    }
    await router.push({ name: '应用对话', params: { id: String(res.data.data) } })
  } catch (error) {
    message.error(error instanceof Error ? error.message : '创建失败，请重试')
  } finally {
    creating.value = false
  }
}

function handlePromptKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void createApp()
}

async function loadWorks(collection: typeof myWorks, list: typeof listMyAppVoByPage) {
  const page = collection.page
  collection.loading = true
  collection.error = false
  try {
    const { data } = await list({
      pageNum: page,
      pageSize,
      sortField: 'createTime',
      sortOrder: 'desc',
    })
    if (collection.page !== page) return
    if (data.code !== 0 || !data.data) throw new Error(data.message)
    collection.records = data.data.records ?? []
    collection.total = data.data.totalRow ?? 0
  } catch {
    if (collection.page === page) collection.error = true
  } finally {
    if (collection.page === page) collection.loading = false
  }
}

const collections = [
  {
    id: 'my-works',
    title: '我的作品',
    isMine: true,
    state: myWorks,
    load: () => loadWorks(myWorks, listMyAppVoByPage),
  },
  {
    id: 'featured-works',
    title: '精选案例',
    isMine: false,
    state: featured,
    load: () => loadWorks(featured, listGoodAppVoByPage),
  },
]

onMounted(() => {
  if (loginStore.loginUser.id) void collections[0].load()
  void collections[1].load()
})
</script>

<template>
  <div id="homePage">
    <section class="hero" aria-labelledby="create-heading">
      <h1 id="create-heading" lang="en">Build something <em>real.</em></h1>
      <form class="creation-composer home-composer" @submit.prevent="createApp">
        <textarea
          ref="promptInput"
          v-model="userPrompt"
          aria-label="描述想创建的网站"
          placeholder="描述你想创建的网站..."
          :maxlength="1000"
          @keydown="handlePromptKey"
        />
        <div class="composer-controls">
          <span class="composer-kind"><AppstoreOutlined aria-hidden="true" /> 网站</span>
          <button
            class="creation-send"
            type="submit"
            aria-label="创建网站"
            :disabled="creating"
            :aria-busy="creating"
          >
            <ArrowUpOutlined aria-hidden="true" />
          </button>
        </div>
      </form>
      <div class="prompt-examples">
        <button
          v-for="example in examples"
          :key="example.label"
          class="creation-chip"
          type="button"
          @click="setPrompt(example.prompt)"
        >
          <component :is="example.icon" aria-hidden="true" /> {{ example.label }}
        </button>
      </div>
    </section>

    <div class="collections">
      <section
        v-for="collection in collections"
        :id="collection.id"
        :key="collection.id"
        :aria-labelledby="collection.id + '-title'"
      >
        <div class="section-heading">
          <h2 :id="collection.id + '-title'">{{ collection.title }}</h2>
          <button
            v-if="collection.isMine"
            class="creation-chip new-project"
            type="button"
            @click="focusPrompt"
          >
            <PlusOutlined aria-hidden="true" /> 新建作品
          </button>
        </div>
        <div v-if="collection.isMine && !loginStore.loginUser.id" class="collection-status">
          <RouterLink to="/user/login">登录</RouterLink>后可查看自己的作品
        </div>
        <div v-else-if="collection.state.error" class="collection-status" role="status">
          作品加载失败
          <button class="creation-chip" type="button" @click="collection.load">重试</button>
        </div>
        <p v-else-if="collection.state.loading" class="collection-status" role="status">
          正在加载作品…
        </p>
        <p v-else-if="!collection.state.records.length" class="collection-status">
          {{ collection.isMine ? '还没有作品' : '暂无精选案例' }}
        </p>
        <div v-else class="project-grid">
          <AppCard
            v-for="app in collection.state.records"
            :key="app.id"
            :app="app"
            :featured="!collection.isMine"
          />
        </div>
        <a-pagination
          v-if="collection.state.total > pageSize"
          v-model:current="collection.state.page"
          class="pagination"
          :page-size="pageSize"
          :total="collection.state.total"
          :show-size-changer="false"
          @change="collection.load"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
#homePage {
  max-width: 1216px;
  margin-inline: auto;
  padding: 0 32px 64px;
}

.hero {
  max-width: 744px;
  margin: 0 auto;
  padding: 67px 0 61px;
}

.hero h1 {
  margin: 0 0 34px;
  text-align: center;
  font-size: clamp(40px, 5.5vw, 79px);
  line-height: 1.06;
  letter-spacing: -0.075em;
  font-weight: 700;
}

.hero em {
  color: var(--orange);
  font-style: normal;
}

.home-composer {
  min-height: 155px;
  padding: 17px 14px 12px 18px;
  box-shadow:
    0 2px 4px #30281408,
    0 7px 18px #30281407;
}

.home-composer textarea {
  min-height: 83px;
  font-size: 16px;
}
.composer-kind {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 4px;
  color: var(--muted);
  font-size: 12px;
}
.prompt-examples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}

.collections {
  border-top: 1px solid var(--line);
  padding-top: 23px;
}
.collections section {
  scroll-margin-top: 20px;
}
.collections section + section {
  margin-top: 36px;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 35px;
  gap: 12px;
  margin-bottom: 13px;
}
.section-heading h2 {
  margin: 0;
  font-size: 21px;
  letter-spacing: -0.035em;
  font-weight: 650;
}
.new-project {
  font-weight: 600;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.collection-status {
  margin: 0;
  padding: 22px 0;
  color: var(--muted);
}
.collection-status a {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.collection-status button {
  margin-left: 8px;
}
.pagination {
  margin-top: 18px;
  justify-content: end;
}

@media (max-width: 800px) {
  #homePage {
    padding-inline: 20px;
  }
  .hero {
    padding-block: 53px 45px;
  }
  .project-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 500px) {
  #homePage {
    padding-inline: 16px;
  }
  .hero {
    padding-top: 44px;
  }
  .hero h1 {
    margin-bottom: 24px;
  }
  .project-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
