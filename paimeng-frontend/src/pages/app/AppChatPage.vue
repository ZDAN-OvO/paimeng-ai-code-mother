<template>
  <div id="appChatPage">
    <header class="workspace-header">
      <div class="work-identity">
        <RouterLink to="/" class="quiet-control back-link" aria-label="返回首页">
          <ArrowLeftOutlined /><span class="action-label">返回首页</span>
        </RouterLink>
        <h1 class="app-name">{{ appInfo?.appName || '网站生成器' }}</h1>
        <span v-if="appInfo?.codeGenType" class="type-tag">{{
          formatCodeGenType(appInfo.codeGenType)
        }}</span>
      </div>
      <div class="workspace-actions">
        <button type="button" class="quiet-control" aria-label="应用详情" @click="showAppDetail">
          <InfoCircleOutlined /><span class="action-label">应用详情</span>
        </button>
        <button
          type="button"
          class="quiet-control"
          aria-label="下载代码"
          :disabled="!isOwner || downloading"
          @click="downloadCode"
        >
          <DownloadOutlined /><span class="action-label">下载代码</span>
        </button>
        <a-dropdown v-if="deployUrl && !deploying" :trigger="['click']" placement="bottomRight">
          <button type="button" class="deploy-control deploy-status">
            <CheckOutlined aria-hidden="true" /> 已部署
          </button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="open"
                ><a :href="deployUrl" target="_blank" rel="noopener noreferrer"
                  >打开发布网站</a
                ></a-menu-item
              >
              <a-menu-item key="copy"
                ><button class="deploy-menu-action" type="button" @click="copyDeployUrl">
                  复制链接
                </button></a-menu-item
              >
              <a-menu-item v-if="isOwner" key="redeploy"
                ><button class="deploy-menu-action" type="button" @click="deployApp">
                  重新部署
                </button></a-menu-item
              >
            </a-menu>
          </template>
        </a-dropdown>
        <button
          v-else
          type="button"
          class="deploy-control"
          :class="{ 'deploy-status': deploying }"
          :disabled="!isOwner || !previewUrl || deploying"
          :aria-busy="deploying"
          @click="deployApp"
        >
          <CloudUploadOutlined aria-hidden="true" /> {{ deploying ? '部署中…' : '部署' }}
        </button>
      </div>
    </header>

    <div class="mobile-tabs" aria-label="工作区视图">
      <button type="button" :aria-pressed="activePanel === 'chat'" @click="activePanel = 'chat'">
        查看对话
      </button>
      <button
        type="button"
        :aria-pressed="activePanel === 'preview'"
        @click="activePanel = 'preview'"
      >
        查看预览
      </button>
    </div>

    <div
      ref="workspaceGrid"
      class="workspace-grid"
      :class="['show-' + activePanel, { 'is-dragging': dragging }]"
      :style="chatWidth == null ? undefined : { '--chat-width': chatWidth + 'px' }"
    >
      <section id="workspace-chat" class="chat-section" aria-labelledby="chat-title">
        <div class="panel-heading chat-heading">
          <h2 id="chat-title">对话</h2>
          <span class="preview-status">{{ previewUrl ? '预览已就绪' : '等待预览' }}</span>
        </div>
        <div ref="messagesContainer" class="messages-container">
          <div v-if="hasMoreHistory" class="history-control">
            <button
              type="button"
              class="creation-chip"
              :disabled="loadingHistory"
              @click="loadMoreHistory"
            >
              {{ loadingHistory ? '正在加载…' : '加载更多历史消息' }}
            </button>
          </div>
          <div v-for="entry in messages" :key="entry.key" class="message-item">
            <div v-if="entry.type === 'user'" class="user-message">{{ entry.content }}</div>
            <div v-else class="ai-message">
              <span class="ai-mark" aria-hidden="true">✱</span>
              <div class="ai-content">
                <strong class="ai-name">派蒙</strong>
                <MarkdownRenderer v-if="entry.content" :content="entry.content" />
                <div v-if="entry.error" class="task-error" role="status">{{ entry.error }}</div>
                <details
                  v-if="entry !== liveTask?.assistant && entry.statuses?.length"
                  class="task-details"
                >
                  <summary>生成记录</summary>
                  <div v-for="status in entry.statuses" :key="status.id">{{ status.text }}</div>
                </details>
                <div v-if="isGenerating && entry === liveTask?.assistant" class="generation">
                  <div class="generation-label" role="status">{{ generationLabel }}</div>
                  <div class="progress-track" role="progressbar" aria-label="生成进度">
                    <span />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div
            v-if="previewUrl && isOwner && !isChatBusy && messages.length && !latestMessage?.error"
            class="followups"
          >
            <div class="preview-status"><CheckOutlined /> 预览已就绪</div>
            <button
              v-for="suggestion in suggestions"
              :key="suggestion"
              type="button"
              class="creation-chip"
              :disabled="!!userInput.trim()"
              @click="useSuggestion(suggestion)"
            >
              <PlusOutlined aria-hidden="true" /> {{ suggestion }}
            </button>
          </div>
          <p v-if="!isOwner && appInfo && !messages.length" class="read-only-note">
            对话仅作品所有者可编辑。
          </p>
        </div>

        <a-alert
          v-if="selectedElementInfo"
          class="selected-element-alert"
          type="info"
          closable
          @close="clearSelectedElement"
        >
          <template #message>
            <div class="selected-element-info">
              <div class="element-header">
                <span class="element-tag">
                  选中元素：{{ selectedElementInfo.tagName.toLowerCase() }}
                </span>
                <span v-if="selectedElementInfo.id" class="element-id">
                  #{{ selectedElementInfo.id }}
                </span>
                <span v-if="selectedElementInfo.className" class="element-class">
                  .{{ selectedElementInfo.className.split(' ').join('.') }}
                </span>
              </div>
              <div class="element-details">
                <div v-if="selectedElementInfo.textContent" class="element-item">
                  内容: {{ selectedElementInfo.textContent.substring(0, 50) }}
                  {{ selectedElementInfo.textContent.length > 50 ? '...' : '' }}
                </div>
                <div v-if="selectedElementInfo.pagePath" class="element-item">
                  页面路径: {{ selectedElementInfo.pagePath }}
                </div>
                <div class="element-item">
                  选择器:
                  <code class="element-selector-code">{{ selectedElementInfo.selector }}</code>
                </div>
              </div>
            </div>
          </template>
        </a-alert>

        <form class="composer-area" @submit.prevent="sendMessage">
          <div class="creation-composer chat-composer">
            <textarea
              ref="chatInput"
              v-model="userInput"
              aria-label="对话输入"
              :placeholder="getInputPlaceholder()"
              :maxlength="1000"
              :disabled="!isOwner || isChatBusy"
              @keydown="handleChatKey"
            />
            <div class="composer-controls">
              <span v-if="isOwner" class="shortcut">回车发送 · ⇧↵ 换行</span>
              <span v-else class="shortcut">只读</span>
              <button
                class="creation-send"
                type="submit"
                aria-label="发送消息"
                :disabled="!isOwner || isChatBusy"
              >
                <ArrowUpOutlined />
              </button>
            </div>
          </div>
        </form>
      </section>

      <div
        class="splitter"
        role="separator"
        tabindex="0"
        aria-label="调整对话区宽度"
        aria-orientation="vertical"
        aria-controls="workspace-chat"
        :aria-valuemin="MIN_CHAT_WIDTH"
        :aria-valuemax="maxChatWidth"
        :aria-valuenow="currentChatWidth"
        @keydown="resizeWithKeyboard"
        @pointerdown="startResize"
        @pointermove="moveResize"
        @pointerup="stopResize"
        @pointercancel="stopResize"
        @lostpointercapture="stopResize"
      />

      <section class="preview-section" aria-labelledby="preview-title">
        <div class="panel-heading preview-toolbar">
          <h2 id="preview-title">预览</h2>
          <div class="preview-address" :title="previewAddress">
            <LinkOutlined /><span>{{ previewAddress || '等待预览' }}</span>
          </div>
          <div class="preview-actions">
            <button
              v-if="isOwner && previewUrl"
              type="button"
              class="quiet-control edit-control"
              :aria-label="editLabel"
              :aria-pressed="isEditMode"
              :title="editLabel"
              @click="toggleEditMode"
            >
              <EditOutlined /><span>{{ editLabel }}</span>
            </button>
            <div class="viewport-switch" aria-label="预览尺寸">
              <button
                type="button"
                class="icon-control"
                title="桌面预览"
                aria-label="桌面预览"
                :aria-pressed="!phonePreview"
                @click="phonePreview = false"
              >
                <DesktopOutlined />
              </button>
              <button
                type="button"
                class="icon-control"
                title="手机预览"
                aria-label="手机预览"
                :aria-pressed="phonePreview"
                @click="phonePreview = true"
              >
                <MobileOutlined />
              </button>
            </div>
            <button
              type="button"
              class="icon-control"
              title="刷新预览"
              aria-label="刷新预览"
              :disabled="!previewUrl"
              @click="refreshPreview"
            >
              <ReloadOutlined />
            </button>
            <button
              type="button"
              class="icon-control"
              title="新窗口打开"
              aria-label="新窗口打开"
              :disabled="!previewUrl"
              @click="openInNewTab"
            >
              <ExportOutlined />
            </button>
          </div>
        </div>
        <div class="preview-stage" :class="{ 'phone-preview': phonePreview }">
          <div class="preview-canvas">
            <iframe
              v-if="previewUrl"
              :key="previewKey"
              ref="previewFrame"
              :src="previewUrl"
              title="网站预览"
              @load="onIframeLoad"
            />
            <div v-else class="preview-empty" role="status">
              <span class="preview-empty-icon"><GlobalOutlined /></span>
              <span>{{ isGenerating ? '正在生成网站…' : '网站生成后将在这里预览' }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <AppDetailModal
      v-model:open="appDetailVisible"
      :app="appInfo"
      :show-actions="isOwner || isAdmin"
      @edit="editApp"
      @delete="deleteApp"
    />

    <div v-if="showDeployNotice" class="deployment-notice">
      <span class="notice-icon" aria-hidden="true"><CheckOutlined /></span>
      <div role="status">
        <strong>部署成功</strong>
        <p>{{ appInfo?.appName || '网站' }}已发布。</p>
      </div>
      <button
        type="button"
        class="icon-control"
        aria-label="关闭部署提示"
        @click="dismissDeployNotice"
      >
        <CloseOutlined />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, onMounted, nextTick, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { useLoginUserStore } from '@/stores/loginUser'
import {
  getAppVoById,
  deployApp as deployAppApi,
  deleteApp as deleteAppApi,
} from '@/api/appController'
import { listAppChatHistory } from '@/api/chatHistoryController'
import { buildTaskEventsUrl, createChatTask, getActiveChatTask } from '@/api/appTaskController'
import { CodeGenTypeEnum, formatCodeGenType } from '@/utils/codeGenTypes'
import request from '@/request'

import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import AppDetailModal from '@/components/AppDetailModal.vue'
import { getDeployUrl, getStaticPreviewUrl } from '@/config/env'
import { VisualEditor, type ElementInfo } from '@/utils/visualEditor'

import {
  CloudUploadOutlined,
  ArrowUpOutlined,
  ArrowLeftOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  DownloadOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  DesktopOutlined,
  GlobalOutlined,
  LinkOutlined,
  MobileOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons-vue'

const route = useRoute()
const router = useRouter()
const loginUserStore = useLoginUserStore()

interface ChatPage {
  appId: string
  signal: AbortSignal
}

interface Message {
  key: string
  type: 'user' | 'ai'
  content: string
  loading?: boolean
  statuses?: { id: string; text: string }[]
  error?: string
}

interface TaskSession {
  id: string
  running: boolean
  lastEventId?: string
  optimisticUser?: Message
  assistant: Message
  needsUserHistory: boolean
}

const HISTORY_PAGE_SIZE = 10
const TASK_RECOVERY_DELAY = 2000
const MIN_CHAT_WIDTH = 300
const DESKTOP_WIDTH = 800
const suggestions = ['补充联系信息', '调整为深色主题']
const appInfo = ref<API.AppVO>()
const appId = ref('')
const historyMessages = ref<Message[]>([])
const liveTask = ref<TaskSession>()
const userInput = ref('')
const chatInput = ref<HTMLTextAreaElement>()
const checkingTask = ref(false)
const submitting = ref(false)
const isGenerating = computed(() => liveTask.value?.running ?? false)
const generationLabel = computed(() => {
  const statuses = liveTask.value?.assistant.statuses ?? []
  return statuses[statuses.length - 1]?.text || '正在生成网站…'
})
const isChatBusy = computed(() => checkingTask.value || submitting.value || isGenerating.value)
const messages = computed(() => {
  const task = liveTask.value
  if (!task) return historyMessages.value
  return [
    ...historyMessages.value,
    ...(task.optimisticUser ? [task.optimisticUser] : []),
    task.assistant,
  ]
})
const messagesContainer = ref<HTMLElement>()
const latestMessage = computed(() => messages.value[messages.value.length - 1])

const loadingHistory = ref(false)
const hasMoreHistory = ref(false)
let historyCursor: { lastCreateTime: string; lastId: string } | undefined
let historyRequest = 0
let pageController: AbortController | undefined
let eventSource: EventSource | undefined
let recoveryTimer: ReturnType<typeof setTimeout> | undefined
let pendingDraft: { content: string; requestId: string } | undefined

// 预览相关
const previewUrl = ref('')
const previewFrame = shallowRef<HTMLIFrameElement | null>(null)
const previewKey = ref(0)
const previewAddress = computed(() => {
  if (!previewUrl.value) return ''
  const url = new URL(previewUrl.value, window.location.origin)
  return url.host + url.pathname
})
const phonePreview = ref(false)
const activePanel = ref<'chat' | 'preview'>('chat')
const workspaceGrid = ref<HTMLElement>()
const workspaceWidth = ref(0)
const chatWidth = ref<number>()
const dragging = ref(false)
let activePointer: { id: number; offset: number } | undefined
let workspaceObserver: ResizeObserver | undefined

const maxChatWidth = computed(() =>
  Math.max(
    MIN_CHAT_WIDTH,
    Math.floor(Math.min(workspaceWidth.value * 0.62, workspaceWidth.value - 381)),
  ),
)
const currentChatWidth = computed(() => {
  const defaultWidth = Math.max(320, Math.min(workspaceWidth.value * 0.29, 445))
  return Math.min(maxChatWidth.value, chatWidth.value ?? Math.round(defaultWidth))
})

// 部署相关
const deploying = ref(false)
const deployUrl = ref('')
const showDeployNotice = ref(false)
let deployNoticeTimer: ReturnType<typeof setTimeout> | undefined

// 下载相关
const downloading = ref(false)

// 可视化编辑相关
const editState = ref<'idle' | 'starting' | 'editing'>('idle')
const isEditMode = computed(() => editState.value === 'editing')
const editLabel = computed(() =>
  isEditMode.value ? '退出编辑' : editState.value === 'starting' ? '取消开启' : '编辑模式',
)
const selectedElementInfo = ref<ElementInfo | null>(null)
const visualEditor = new VisualEditor({
  onElementSelected: (elementInfo: ElementInfo) => {
    selectedElementInfo.value = elementInfo
  },
  onSelectionCleared: () => {
    selectedElementInfo.value = null
  },
  onEditStateChange: (state) => {
    editState.value = state
    if (state === 'idle') selectedElementInfo.value = null
  },
  onEditTimeout: () => message.warning('预览未能开启编辑，请刷新后重试'),
})

// 权限相关
const isOwner = computed(() => {
  const ownerId = appInfo.value?.userId
  const loginId = loginUserStore.loginUser.id
  return ownerId != null && loginId != null && String(ownerId) === String(loginId)
})

const isAdmin = computed(() => {
  return loginUserStore.loginUser.userRole === 'admin'
})

// 应用详情相关
const appDetailVisible = ref(false)

// 显示应用详情
const showAppDetail = () => {
  appDetailVisible.value = true
}

// 分页游标原样回传，保留同一秒内的排序。
async function loadChatHistory(page: ChatPage, { more = false, onlyUserTail = false } = {}) {
  if (page.signal.aborted || (more && (loadingHistory.value || !historyCursor))) return false
  const requestNumber = ++historyRequest
  loadingHistory.value = true
  try {
    const res = await listAppChatHistory(
      { appId: page.appId, pageSize: HISTORY_PAGE_SIZE, ...(more ? historyCursor : {}) },
      { signal: page.signal },
    )
    if (page.signal.aborted || requestNumber !== historyRequest) return false
    if (res.data.code !== 0 || !res.data.data) {
      throw new Error(res.data.message || '加载对话历史失败')
    }

    const records = res.data.data.records ?? []
    // 活跃任务只补已落库的用户消息，助手结果由终态统一对齐。
    if (onlyUserTail && records[0]?.messageType !== 'user') return false
    const incoming = records
      .map<Message>((chat, index) => ({
        key: `history:${chat.id ?? `${chat.createTime}:${index}`}`,
        type: chat.messageType === 'user' ? 'user' : 'ai',
        content: chat.message ?? '',
      }))
      .reverse()

    if (more) {
      historyMessages.value.unshift(...incoming)
    } else {
      const overlap = historyMessages.value.findIndex((chat) => chat.key === incoming[0]?.key)
      if (overlap > 0) {
        // 保留已经展开的更早历史和相应游标。
        historyMessages.value = [...historyMessages.value.slice(0, overlap), ...incoming]
        return true
      }
      historyMessages.value = incoming
    }
    const oldest = records[records.length - 1]
    historyCursor =
      oldest?.createTime && oldest.id
        ? { lastCreateTime: oldest.createTime, lastId: String(oldest.id) }
        : undefined
    hasMoreHistory.value = Boolean(historyCursor && records.length === HISTORY_PAGE_SIZE)
    return true
  } catch (error) {
    if (!page.signal.aborted && requestNumber === historyRequest && !onlyUserTail) {
      console.error('加载对话历史失败：', error)
      message.error('加载对话历史失败')
    }
    return false
  } finally {
    if (requestNumber === historyRequest && !page.signal.aborted) loadingHistory.value = false
  }
}

function loadMoreHistory() {
  const page = getCurrentPage()
  if (page) void loadChatHistory(page, { more: true })
}

function getCurrentPage(): ChatPage | undefined {
  if (pageController && appId.value) {
    return { appId: appId.value, signal: pageController.signal }
  }
}

async function readActiveTask(page: ChatPage) {
  const res = await getActiveChatTask(page.appId, page.signal)
  if (res.data.code !== 0) throw new Error(res.data.message || '查询生成任务失败')
  return res.data.data ?? null
}

function isRunning(task: API.ActiveChatTask) {
  const status = task.status.toLowerCase()
  return status === 'running' || status === 'committing'
}

function isSuccessful(task: API.ActiveChatTask) {
  const status = task.status.toLowerCase()
  return task.resultCommitted && (status === 'succeeded' || status === 'success')
}

async function fetchAppInfo(page: ChatPage) {
  try {
    const res = await getAppVoById({ id: page.appId as unknown as number }, { signal: page.signal })
    if (page.signal.aborted) return
    if (res.data.code !== 0 || !res.data.data) throw new Error(res.data.message)
    appInfo.value = res.data.data
    deployUrl.value = res.data.data.deployKey ? getDeployUrl(res.data.data.deployKey) : ''
  } catch (error) {
    if (!page.signal.aborted) {
      console.error('获取应用信息失败：', error)
      message.error('获取应用信息失败')
      void router.push('/')
    }
    return
  }

  try {
    if (!isOwner.value) {
      if (isAdmin.value) {
        await loadChatHistory(page)
        void restorePreview(page)
      }
      return
    }
    const firstTask = await readActiveTask(page)
    if (page.signal.aborted) return
    const loaded = await loadChatHistory(page)
    if (page.signal.aborted) return
    const latestTask = await readActiveTask(page)
    if (page.signal.aborted) return

    if (latestTask?.resultCommitted && !isRunning(latestTask)) {
      await loadChatHistory(page)
      if (page.signal.aborted) return
    }
    if (latestTask && isSuccessful(latestTask)) {
      updatePreview(latestTask.taskId)
    } else if (historyMessages.value.length || latestTask) {
      void restorePreview(page)
    }

    if (latestTask && isRunning(latestTask)) {
      subscribeTaskStream(page, latestTask.taskId)
    } else if (!latestTask && !firstTask && loaded && historyMessages.value.length === 0) {
      const prompt = appInfo.value.initPrompt
      if (prompt) await submitTask(page, prompt, `init:${page.appId}`, true)
    }
    scrollToBottom()
  } catch (error) {
    if (!page.signal.aborted) {
      console.error('查询生成任务失败：', error)
      if (historyMessages.value.length === 0) await loadChatHistory(page)
      if (page.signal.aborted) return
      void restorePreview(page)
      message.error('查询生成任务失败，请刷新后重试')
    }
  }
}

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  // 局域网 HTTP 等环境可能只开放 getRandomValues。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

async function sendMessage() {
  const page = getCurrentPage()
  const draft = userInput.value.trim()
  if (!page || !draft || !isOwner.value || isChatBusy.value) return

  let content = draft
  const element = selectedElementInfo.value
  if (element) {
    content += '\n\n选中元素信息：'
    if (element.pagePath) content += `\n- 页面路径: ${element.pagePath}`
    content += `\n- 标签: ${element.tagName.toLowerCase()}\n- 选择器: ${element.selector}`
    if (element.textContent) content += `\n- 当前内容: ${element.textContent.substring(0, 100)}`
  }

  if (pendingDraft?.content !== content) pendingDraft = { content, requestId: newRequestId() }
  await submitTask(page, content, pendingDraft.requestId)
}

async function submitTask(page: ChatPage, content: string, requestId: string, initial = false) {
  submitting.value = true
  try {
    const res = await createChatTask(
      { appId: page.appId, message: content, clientRequestId: requestId },
      page.signal,
    )
    if (page.signal.aborted) return

    const result = res.data.data
    if (res.data.code !== 0 || !result) {
      throw new Error(res.data.message || '提交生成任务失败，请重试')
    }
    if (!initial) pendingDraft = undefined
    if (result.code === 'HISTORY_EXISTS') {
      await loadChatHistory(page)
      void restorePreview(page)
      scrollToBottom()
      return
    }
    if (!result.taskId) throw new Error('服务器未返回生成任务编号')

    if (result.conflict) message.info('该应用正在生成')
    const accepted = !result.reused && !result.conflict
    if (accepted && !initial) {
      userInput.value = ''
      if (selectedElementInfo.value) visualEditor.disableEditMode()
    }
    subscribeTaskStream(page, result.taskId, accepted ? content : undefined)
  } catch (error) {
    if (!page.signal.aborted) {
      message.error(error instanceof Error ? error.message : '提交生成任务失败，请重试')
    }
  } finally {
    if (!page.signal.aborted) submitting.value = false
  }
}

function closeTaskStream() {
  clearTimeout(recoveryTimer)
  recoveryTimer = undefined
  const source = eventSource
  eventSource = undefined
  source?.close()
}

function subscribeTaskStream(page: ChatPage, taskId: string, acceptedMessage?: string) {
  if (page.signal.aborted || (liveTask.value?.id === taskId && liveTask.value.running)) return
  closeTaskStream()
  liveTask.value = {
    id: taskId,
    running: true,
    needsUserHistory: acceptedMessage === undefined,
    optimisticUser:
      acceptedMessage === undefined
        ? undefined
        : { key: `task:${taskId}:user`, type: 'user', content: acceptedMessage },
    assistant: { key: `task:${taskId}:ai`, type: 'ai', content: '', loading: true, statuses: [] },
  }
  connectTaskStream(page, liveTask.value)
  scrollToBottom()
}

function isNewEventId(id: string, previous?: string) {
  const streamId = /^(\d+)-(\d+)$/
  const next = streamId.exec(id)
  if (!next) return false
  if (!previous) return true
  const last = streamId.exec(previous)!
  const time = BigInt(next[1]!) - BigInt(last[1]!)
  return time > 0n || (time === 0n && BigInt(next[2]!) > BigInt(last[2]!))
}

const statusLabels = {
  tool_running: '正在调用工具',
  tool_completed: '工具调用完成',
  tool_failed: '工具调用失败',
  building: '正在构建网站',
  repairing: '正在修复并重新构建',
  committing: '正在交付网站',
}

function formatTaskStatus(status: API.ChatTaskStatusEvent) {
  if (status.phase === 'resync_required') return ''
  const label = statusLabels[status.phase]
  const tool = status.toolName ? ` · ${status.toolName}` : ''
  const attempt =
    status.attempt && (status.phase === 'building' || status.phase === 'repairing')
      ? `（第 ${status.attempt} 次）`
      : ''
  return `${label}${tool}${attempt}${status.message ? `：${status.message}` : ''}`
}

function connectTaskStream(page: ChatPage, task: TaskSession) {
  const source = new EventSource(buildTaskEventsUrl(task.id, task.lastEventId), {
    withCredentials: true,
  })
  eventSource = source

  function listen<T extends { taskId: string; phase?: API.ChatTaskStatusEvent['phase'] }>(
    name: string,
    apply: (payload: T, id: string) => void,
  ) {
    source.addEventListener(name, (event: MessageEvent<string>) => {
      if (page.signal.aborted || eventSource !== source) return
      let payload: T
      try {
        payload = JSON.parse(event.data)
      } catch (error) {
        console.error('解析生成任务事件失败：', error)
        return
      }
      if (payload?.taskId !== task.id) return

      if (name === 'status' && payload.phase === 'resync_required') {
        // 回源提示可以使用合成 ID，先处理提示，再判断普通事件是否重复。
        closeTaskStream()
        const hadCursor = Boolean(task.lastEventId)
        task.lastEventId = undefined
        task.assistant.content = ''
        task.assistant.statuses = []
        task.assistant.loading = true
        if (hadCursor) void recoverTask(page, task, true)
        else scheduleTaskRecovery(page, task, true)
        return
      }

      if (!isNewEventId(event.lastEventId, task.lastEventId)) return
      task.lastEventId = event.lastEventId
      if (task.needsUserHistory && (name === 'message' || name === 'status')) {
        task.needsUserHistory = false
        void loadChatHistory(page, { onlyUserTail: true }).then(scrollToBottom)
      }
      apply(payload, event.lastEventId)
      scrollToBottom()
    })
  }

  listen<API.ChatTaskMessageEvent>('message', (payload) => {
    if (typeof payload.d === 'string') {
      task.assistant.content += payload.d
      task.assistant.loading = false
    }
  })
  listen<API.ChatTaskStatusEvent>('status', (payload, id) => {
    task.assistant.statuses?.push({ id, text: formatTaskStatus(payload) })
    task.assistant.loading = false
  })
  listen<API.ChatTaskDoneEvent>('done', (payload) => {
    if (payload.status === 'success') void finishTask(page, task, { previewTaskId: task.id })
  })
  listen<API.ChatTaskErrorEvent>('business-error', (payload) => {
    if (payload.status === 'failed') {
      void finishTask(page, task, { error: payload.message || '生成过程中出现错误' })
    }
  })

  source.onerror = () => {
    // CONNECTING 时由浏览器带 Last-Event-ID 自动重连，保留当前气泡和游标。
    if (eventSource !== source || source.readyState !== EventSource.CLOSED) return
    closeTaskStream()
    scheduleTaskRecovery(page, task, false)
  }
}

function scheduleTaskRecovery(page: ChatPage, task: TaskSession, reloadHistory: boolean) {
  recoveryTimer = setTimeout(() => void recoverTask(page, task, reloadHistory), TASK_RECOVERY_DELAY)
}

async function recoverTask(page: ChatPage, task: TaskSession, reloadHistory: boolean) {
  try {
    if (reloadHistory) {
      const loaded = await loadChatHistory(page, { onlyUserTail: true })
      const newest = historyMessages.value[historyMessages.value.length - 1]
      if (loaded && newest?.content === task.optimisticUser?.content) {
        task.optimisticUser = undefined
      }
    }
    if (page.signal.aborted || liveTask.value !== task) return

    const latest = await readActiveTask(page)
    if (page.signal.aborted || liveTask.value !== task) return
    if (latest?.taskId === task.id && !latest.resultCommitted && !isRunning(latest)) {
      scheduleTaskRecovery(page, task, reloadHistory)
      return
    }
    if (latest && isRunning(latest)) {
      if (latest.taskId !== task.id) {
        await loadChatHistory(page, { onlyUserTail: true })
        if (!page.signal.aborted) subscribeTaskStream(page, latest.taskId)
      } else if (latest.streamAvailable) {
        connectTaskStream(page, task)
      } else {
        scheduleTaskRecovery(page, task, false)
      }
    } else {
      await finishTask(page, task, {
        previewTaskId: latest && isSuccessful(latest) ? latest.taskId : undefined,
      })
    }
  } catch (error) {
    if (!page.signal.aborted && liveTask.value === task) {
      console.error('恢复生成任务事件流失败：', error)
      scheduleTaskRecovery(page, task, reloadHistory)
    }
  }
}

async function finishTask(
  page: ChatPage,
  task: TaskSession,
  result: { previewTaskId?: string; error?: string },
) {
  const { previewTaskId, error } = result
  closeTaskStream()
  task.running = false
  task.assistant.loading = false
  task.assistant.error = error
  checkingTask.value = true
  if (previewTaskId) updatePreview(previewTaskId)

  const loaded = await loadChatHistory(page)
  if (page.signal.aborted) return
  if (loaded) {
    const latestMessage = historyMessages.value[historyMessages.value.length - 1]
    if (error && latestMessage?.type === 'ai' && !latestMessage.content.includes(error)) {
      latestMessage.error = error
    }
    liveTask.value = undefined
  }
  checkingTask.value = false
  scrollToBottom()
}

function makePreviewUrl(taskId?: string) {
  const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
  const url = getStaticPreviewUrl(codeGenType, appId.value)
  return taskId ? `${url}?${new URLSearchParams({ task: taskId })}` : url
}

async function restorePreview(page: ChatPage) {
  if (page.signal.aborted || previewUrl.value) return
  const url = makePreviewUrl()
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: page.signal,
    })
    void response.body?.cancel().catch(() => {})
    const isHtml = response.headers.get('content-type')?.startsWith('text/html')
    if (response.ok && isHtml && !page.signal.aborted && !previewUrl.value) {
      updatePreview()
      scrollToBottom()
    }
  } catch {
    // 初次生成与旧产物不可用时，继续展示预览空态。
  }
}

function updatePreview(taskId?: string) {
  const nextUrl = makePreviewUrl(taskId)
  if (previewUrl.value !== nextUrl) {
    visualEditor.disconnect()
    previewUrl.value = nextUrl
    previewKey.value++
  }
}

function refreshPreview() {
  visualEditor.disconnect()
  previewKey.value++
}

function handleChatKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void sendMessage()
}

function useSuggestion(suggestion: string) {
  if (userInput.value.trim() || !isOwner.value || isChatBusy.value) return
  userInput.value = suggestion
  chatInput.value?.focus()
}

function setChatWidth(width: number) {
  chatWidth.value = Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(maxChatWidth.value, width)))
}

function startResize(event: PointerEvent) {
  if (event.button !== 0 || activePointer || !workspaceGrid.value) return
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  activePointer = {
    id: event.pointerId,
    offset:
      event.clientX - workspaceGrid.value.getBoundingClientRect().left - currentChatWidth.value,
  }
  dragging.value = true
  event.preventDefault()
}

function moveResize(event: PointerEvent) {
  if (!activePointer || activePointer.id !== event.pointerId || !workspaceGrid.value) return
  setChatWidth(
    event.clientX - workspaceGrid.value.getBoundingClientRect().left - activePointer.offset,
  )
}

function stopResize(event?: PointerEvent) {
  if (event && activePointer?.id !== event.pointerId) return
  activePointer = undefined
  dragging.value = false
}

function resizeWithKeyboard(event: KeyboardEvent) {
  const width = currentChatWidth.value
  const target = {
    ArrowLeft: width - 16,
    ArrowRight: width + 16,
    Home: MIN_CHAT_WIDTH,
    End: maxChatWidth.value,
  }[event.key]
  if (target == null) return
  event.preventDefault()
  setChatWidth(target)
}

function scrollToBottom() {
  void nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// 下载代码
const downloadCode = async () => {
  const page = getCurrentPage()
  if (!page || !isOwner.value || downloading.value) return
  downloading.value = true
  try {
    const API_BASE_URL = request.defaults.baseURL || ''
    const url = `${API_BASE_URL.replace(/\/$/, '')}/app/download/${page.appId}`
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: page.signal,
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`)
    }
    // 获取文件名
    const contentDisposition = response.headers.get('Content-Disposition')
    const fileName = contentDisposition?.match(/filename="(.+)"/)?.[1] || `app-${appId.value}.zip`
    // 下载文件
    const blob = await response.blob()
    if (page.signal.aborted) return
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fileName
    link.click()
    // 清理
    URL.revokeObjectURL(downloadUrl)
    message.success('代码下载成功')
  } catch (error) {
    if (!page.signal.aborted) {
      console.error('下载失败：', error)
      message.error('下载失败，请重试')
    }
  } finally {
    if (!page.signal.aborted) downloading.value = false
  }
}

// 部署应用
const deployApp = async () => {
  const page = getCurrentPage()
  if (!page || !isOwner.value || !previewUrl.value || deploying.value) return

  dismissDeployNotice()
  deploying.value = true
  try {
    const res = await deployAppApi(
      { appId: page.appId as unknown as number },
      { signal: page.signal },
    )
    if (page.signal.aborted) return
    if (res.data.code !== 0 || !res.data.data) throw new Error(res.data.message || '请重试')
    // 服务端提供发布标识，用户打开的链接统一使用前端配置的发布域名。
    const key = new URL(res.data.data).pathname.split('/').filter(Boolean).pop()
    if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('服务器未返回有效的发布地址')
    deployUrl.value = getDeployUrl(key)
    showDeployNotice.value = true
    deployNoticeTimer = setTimeout(dismissDeployNotice, 5000)
  } catch (error) {
    if (!page.signal.aborted) {
      message.error('部署失败：' + (error instanceof Error ? error.message : '请重试'))
    }
  } finally {
    if (!page.signal.aborted) deploying.value = false
  }
}

function dismissDeployNotice() {
  clearTimeout(deployNoticeTimer)
  showDeployNotice.value = false
}

async function copyDeployUrl() {
  const page = getCurrentPage()
  try {
    await navigator.clipboard.writeText(deployUrl.value)
    if (!page?.signal.aborted) message.success('发布链接已复制')
  } catch {
    if (!page?.signal.aborted) message.error('复制失败，请打开网站后复制地址')
  }
}

// 在新窗口打开预览
const openInNewTab = () => {
  if (previewUrl.value) {
    window.open(previewUrl.value, '_blank', 'noopener,noreferrer')
  }
}

const onIframeLoad = (event: Event) => {
  const iframe = previewFrame.value
  if (iframe && event.currentTarget === iframe) visualEditor.onIframeLoad(iframe)
}

// 编辑应用
const editApp = () => {
  if (appInfo.value?.id) {
    router.push(`/app/edit/${appInfo.value.id}`)
  }
}

// 删除应用
const deleteApp = async () => {
  if (!appInfo.value?.id) return

  try {
    const res = await deleteAppApi({ id: appInfo.value.id })
    if (res.data.code === 0) {
      message.success('删除成功')
      appDetailVisible.value = false
      router.push('/')
    } else {
      message.error('删除失败：' + res.data.message)
    }
  } catch (error) {
    console.error('删除失败：', error)
    message.error('删除失败')
  }
}

const toggleEditMode = () => {
  if (!visualEditor.toggleEditMode()) {
    message.warning('预览尚未连接，暂时无法编辑')
  }
}

const clearSelectedElement = () => {
  selectedElementInfo.value = null
  visualEditor.clearSelection()
}

const getInputPlaceholder = () => {
  if (selectedElementInfo.value) {
    return `正在编辑 ${selectedElementInfo.value.tagName.toLowerCase()} 元素，描述您想要的修改...`
  }
  return isOwner.value ? '告诉派蒙你想改些什么…' : '仅作品所有者可以发送消息'
}

function onPreviewMessage(event: MessageEvent) {
  visualEditor.handleIframeMessage(event)
}

watch(
  () => route.params.id,
  async (id) => {
    pageController?.abort()
    closeTaskStream()
    pageController = new AbortController()
    appId.value = typeof id === 'string' ? id : ''
    appInfo.value = undefined
    historyMessages.value = []
    liveTask.value = undefined
    userInput.value = ''
    pendingDraft = undefined
    historyCursor = undefined
    hasMoreHistory.value = false
    loadingHistory.value = false
    checkingTask.value = false
    submitting.value = false
    visualEditor.disconnect()
    previewUrl.value = ''
    deployUrl.value = ''
    deploying.value = false
    downloading.value = false
    appDetailVisible.value = false
    dismissDeployNotice()
    activePanel.value = 'chat'

    const page = getCurrentPage()
    if (!page) return
    checkingTask.value = true
    try {
      await fetchAppInfo(page)
    } finally {
      if (!page.signal.aborted) checkingTask.value = false
    }
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('message', onPreviewMessage)
  const grid = workspaceGrid.value
  if (grid) {
    workspaceWidth.value = grid.clientWidth
    workspaceObserver = new ResizeObserver(() => {
      workspaceWidth.value = grid.clientWidth
      if (workspaceWidth.value < DESKTOP_WIDTH) stopResize()
    })
    workspaceObserver.observe(grid)
  }
})

onUnmounted(() => {
  pageController?.abort()
  closeTaskStream()
  visualEditor.disconnect()
  workspaceObserver?.disconnect()
  dismissDeployNotice()
  window.removeEventListener('message', onPreviewMessage)
})
</script>

<style scoped src="@/pages/app/workspace.css"></style>
