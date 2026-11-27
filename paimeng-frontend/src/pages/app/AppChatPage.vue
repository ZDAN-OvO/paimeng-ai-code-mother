<template>
  <div id="appChatPage">
    <!-- 顶部栏 -->
    <div class="header-bar">
      <div class="header-left">
        <h1 class="app-name">{{ appInfo?.appName || '网站生成器' }}</h1>
        <a-tag v-if="appInfo?.codeGenType" color="blue" class="code-gen-type-tag">
          {{ formatCodeGenType(appInfo.codeGenType) }}
        </a-tag>
      </div>
      <div class="header-right">
        <a-button type="default" @click="showAppDetail">
          <template #icon>
            <InfoCircleOutlined />
          </template>
          应用详情
        </a-button>
        <a-button
          type="primary"
          ghost
          @click="downloadCode"
          :loading="downloading"
          :disabled="!isOwner"
        >
          <template #icon>
            <DownloadOutlined />
          </template>
          下载代码
        </a-button>
        <a-button type="primary" @click="deployApp" :loading="deploying">
          <template #icon>
            <CloudUploadOutlined />
          </template>
          部署
        </a-button>
      </div>
    </div>

    <!-- 主要内容区域 -->
    <div class="main-content">
      <!-- 左侧对话区域 -->
      <div class="chat-section">
        <!-- 消息区域 -->
        <div class="messages-container" ref="messagesContainer">
          <!-- 加载更多按钮 -->
          <div v-if="hasMoreHistory" class="load-more-container">
            <a-button type="link" @click="loadMoreHistory" :loading="loadingHistory" size="small">
              加载更多历史消息
            </a-button>
          </div>
          <div v-for="message in messages" :key="message.key" class="message-item">
            <div v-if="message.type === 'user'" class="user-message">
              <div class="message-content">{{ message.content }}</div>
              <div class="message-avatar">
                <a-avatar :src="loginUserStore.loginUser.userAvatar" />
              </div>
            </div>
            <div v-else class="ai-message">
              <div class="message-avatar">
                <a-avatar :src="aiAvatar" />
              </div>
              <div class="message-content">
                <MarkdownRenderer v-if="message.content" :content="message.content" />
                <div v-for="status in message.statuses" :key="status.id" class="task-status">
                  {{ status.text }}
                </div>
                <div v-if="message.error" class="task-error" role="status">{{ message.error }}</div>
                <div v-if="message.loading" class="loading-indicator">
                  <a-spin size="small" />
                  <span>AI 正在思考...</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 选中元素信息展示 -->
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

        <!-- 用户消息输入框 -->
        <div class="input-container">
          <div class="input-wrapper">
            <a-tooltip v-if="!isOwner" title="无法在别人的作品下对话哦~" placement="top">
              <a-textarea
                v-model:value="userInput"
                :placeholder="getInputPlaceholder()"
                :rows="4"
                :maxlength="1000"
                @keydown.enter.prevent="sendMessage"
                disabled
              />
            </a-tooltip>
            <a-textarea
              v-else
              v-model:value="userInput"
              :placeholder="getInputPlaceholder()"
              :rows="4"
              :maxlength="1000"
              @keydown.enter.prevent="sendMessage"
              :disabled="isChatBusy"
            />
            <div class="input-actions">
              <a-button
                type="primary"
                @click="sendMessage"
                :loading="isGenerating || submitting"
                :disabled="!isOwner || isChatBusy"
              >
                <template #icon>
                  <SendOutlined />
                </template>
              </a-button>
            </div>
          </div>
        </div>
      </div>
      <!-- 右侧网页展示区域 -->
      <div class="preview-section">
        <div class="preview-header">
          <h3>生成后的网页展示</h3>
          <div class="preview-actions">
            <a-button
              v-if="isOwner && previewUrl"
              type="link"
              :danger="isEditMode"
              @click="toggleEditMode"
              :class="{ 'edit-mode-active': isEditMode }"
              style="padding: 0; height: auto; margin-right: 12px"
            >
              <template #icon>
                <EditOutlined />
              </template>
              {{ isEditMode ? '退出编辑' : '编辑模式' }}
            </a-button>
            <a-button v-if="previewUrl" type="link" @click="openInNewTab">
              <template #icon>
                <ExportOutlined />
              </template>
              新窗口打开
            </a-button>
          </div>
        </div>
        <div class="preview-content">
          <div v-if="!previewUrl && !isGenerating" class="preview-placeholder">
            <div class="placeholder-icon">🌐</div>
            <p>网站文件生成完成后将在这里展示</p>
          </div>
          <div v-else-if="!previewUrl" class="preview-loading">
            <a-spin size="large" />
            <p>正在生成网站...</p>
          </div>
          <iframe
            v-else
            :src="previewUrl"
            class="preview-iframe"
            frameborder="0"
            @load="onIframeLoad"
          ></iframe>
        </div>
      </div>
    </div>

    <!-- 应用详情弹窗 -->
    <AppDetailModal
      v-model:open="appDetailVisible"
      :app="appInfo"
      :show-actions="isOwner || isAdmin"
      @edit="editApp"
      @delete="deleteApp"
    />

    <!-- 部署成功弹窗 -->
    <DeploySuccessModal
      v-model:open="deployModalVisible"
      :deploy-url="deployUrl"
      @open-site="openDeployedSite"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, onUnmounted, computed, watch } from 'vue'
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
import DeploySuccessModal from '@/components/DeploySuccessModal.vue'
import aiAvatar from '@/assets/aiAvatar.png'
import { getStaticPreviewUrl } from '@/config/env'
import { VisualEditor, type ElementInfo } from '@/utils/visualEditor'

import {
  CloudUploadOutlined,
  SendOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  DownloadOutlined,
  EditOutlined,
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
const appInfo = ref<API.AppVO>()
const appId = ref('')
const historyMessages = ref<Message[]>([])
const liveTask = ref<TaskSession>()
const userInput = ref('')
const checkingTask = ref(false)
const submitting = ref(false)
const isGenerating = computed(() => liveTask.value?.running ?? false)
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
const previewReady = ref(false)

// 部署相关
const deploying = ref(false)
const deployModalVisible = ref(false)
const deployUrl = ref('')

// 下载相关
const downloading = ref(false)

// 可视化编辑相关
const isEditMode = ref(false)
const selectedElementInfo = ref<ElementInfo | null>(null)
const visualEditor = new VisualEditor({
  onElementSelected: (elementInfo: ElementInfo) => {
    selectedElementInfo.value = elementInfo
  },
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
        if (!page.signal.aborted && historyMessages.value.length >= 2) updatePreview()
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
    } else if (
      historyMessages.value.length >= 2 &&
      (latestTask?.status.toLowerCase() !== 'failed' || historyMessages.value.length > 2)
    ) {
      updatePreview()
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
      if (historyMessages.value.length >= 2) updatePreview()
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
      if (!page.signal.aborted && historyMessages.value.length >= 2 && !previewUrl.value) {
        updatePreview()
      }
      scrollToBottom()
      return
    }
    if (!result.taskId) throw new Error('服务器未返回生成任务编号')

    if (result.conflict) message.info('该应用正在生成')
    const accepted = !result.reused && !result.conflict
    if (accepted && !initial) {
      userInput.value = ''
      if (selectedElementInfo.value) {
        clearSelectedElement()
        if (isEditMode.value) toggleEditMode()
      }
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

function updatePreview(taskId?: string) {
  const codeGenType = appInfo.value?.codeGenType || CodeGenTypeEnum.HTML
  const url = getStaticPreviewUrl(codeGenType, appId.value)
  const nextUrl = taskId ? `${url}?${new URLSearchParams({ task: taskId })}` : url
  if (previewUrl.value !== nextUrl) {
    previewReady.value = false
    previewUrl.value = nextUrl
  }
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
  if (!appId.value) {
    message.error('应用ID不存在')
    return
  }
  downloading.value = true
  try {
    const API_BASE_URL = request.defaults.baseURL || ''
    const url = `${API_BASE_URL}/app/download/${appId.value}`
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`)
    }
    // 获取文件名
    const contentDisposition = response.headers.get('Content-Disposition')
    const fileName = contentDisposition?.match(/filename="(.+)"/)?.[1] || `app-${appId.value}.zip`
    // 下载文件
    const blob = await response.blob()
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fileName
    link.click()
    // 清理
    URL.revokeObjectURL(downloadUrl)
    message.success('代码下载成功')
  } catch (error) {
    console.error('下载失败：', error)
    message.error('下载失败，请重试')
  } finally {
    downloading.value = false
  }
}

// 部署应用
const deployApp = async () => {
  if (!appId.value) {
    message.error('应用ID不存在')
    return
  }

  deploying.value = true
  try {
    const res = await deployAppApi({
      appId: appId.value as unknown as number,
    })

    if (res.data.code === 0 && res.data.data) {
      deployUrl.value = res.data.data
      deployModalVisible.value = true
      message.success('部署成功')
    } else {
      message.error('部署失败：' + res.data.message)
    }
  } catch (error) {
    console.error('部署失败：', error)
    message.error('部署失败，请重试')
  } finally {
    deploying.value = false
  }
}

// 在新窗口打开预览
const openInNewTab = () => {
  if (previewUrl.value) {
    window.open(previewUrl.value, '_blank')
  }
}

// 打开部署的网站
const openDeployedSite = () => {
  if (deployUrl.value) {
    window.open(deployUrl.value, '_blank')
  }
}

// iframe加载完成
const onIframeLoad = () => {
  previewReady.value = true
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (iframe) {
    visualEditor.init(iframe)
    visualEditor.onIframeLoad()
  }
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

// 可视化编辑相关函数
const toggleEditMode = () => {
  // 检查 iframe 是否已经加载
  const iframe = document.querySelector('.preview-iframe') as HTMLIFrameElement
  if (!iframe) {
    message.warning('请等待页面加载完成')
    return
  }
  // 确保 visualEditor 已初始化
  if (!previewReady.value) {
    message.warning('请等待页面加载完成')
    return
  }
  const newEditMode = visualEditor.toggleEditMode()
  isEditMode.value = newEditMode
}

const clearSelectedElement = () => {
  selectedElementInfo.value = null
  visualEditor.clearSelection()
}

const getInputPlaceholder = () => {
  if (selectedElementInfo.value) {
    return `正在编辑 ${selectedElementInfo.value.tagName.toLowerCase()} 元素，描述您想要的修改...`
  }
  return '请描述你想生成的网站，越详细效果越好哦'
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
    previewUrl.value = ''
    previewReady.value = false
    clearSelectedElement()
    visualEditor.disableEditMode()
    isEditMode.value = false

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
})

onUnmounted(() => {
  pageController?.abort()
  closeTaskStream()
  window.removeEventListener('message', onPreviewMessage)
})
</script>

<style scoped>
#appChatPage {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: #fdfdfd;
}

/* 顶部栏 */
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.code-gen-type-tag {
  font-size: 12px;
}

.app-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
}

.header-right {
  display: flex;
  gap: 12px;
}

/* 主要内容区域 */
.main-content {
  flex: 1;
  display: flex;
  gap: 16px;
  padding: 8px;
  overflow: hidden;
}

/* 左侧对话区域 */
.chat-section {
  flex: 2;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.messages-container {
  flex: 0.9;
  padding: 16px;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.message-item {
  margin-bottom: 12px;
}

.user-message {
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  gap: 8px;
}

.ai-message {
  display: flex;
  justify-content: flex-start;
  align-items: flex-start;
  gap: 8px;
}

.message-content {
  max-width: 70%;
  padding: 12px 16px;
  border-radius: 12px;
  line-height: 1.5;
  word-wrap: break-word;
}

.user-message .message-content {
  background: #1890ff;
  color: white;
}

.ai-message .message-content {
  background: #f5f5f5;
  color: #1a1a1a;
  padding: 8px 12px;
}

.message-avatar {
  flex-shrink: 0;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #666;
}

.task-status {
  margin-top: 4px;
  color: #595959;
  font-size: 13px;
}

.task-error {
  margin-top: 4px;
  color: #a8071a;
}

/* 加载更多按钮 */
.load-more-container {
  text-align: center;
  padding: 8px 0;
  margin-bottom: 16px;
}

/* 输入区域 */
.input-container {
  padding: 16px;
  background: white;
}

.input-wrapper {
  position: relative;
}

.input-wrapper .ant-input {
  padding-right: 50px;
}

.input-actions {
  position: absolute;
  bottom: 8px;
  right: 8px;
}

/* 右侧预览区域 */
.preview-section {
  flex: 3;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e8e8e8;
}

.preview-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.preview-actions {
  display: flex;
  gap: 8px;
}

.preview-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
}

.preview-loading p {
  margin-top: 16px;
}

.preview-iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.selected-element-alert {
  margin: 0 16px;
}

/* 响应式设计 */
@media (max-width: 1024px) {
  .main-content {
    flex-direction: column;
  }

  .chat-section,
  .preview-section {
    flex: none;
    height: 50vh;
  }
}

@media (max-width: 768px) {
  .header-bar {
    padding: 12px 16px;
  }

  .app-name {
    font-size: 16px;
  }

  .main-content {
    padding: 8px;
    gap: 8px;
  }

  .message-content {
    max-width: 85%;
  }

  /* 选中元素信息样式 */
  .selected-element-alert {
    margin: 0 16px;
  }

  .selected-element-info {
    line-height: 1.4;
  }

  .element-header {
    margin-bottom: 8px;
  }

  .element-details {
    margin-top: 8px;
  }

  .element-item {
    margin-bottom: 4px;
    font-size: 13px;
  }

  .element-item:last-child {
    margin-bottom: 0;
  }

  .element-tag {
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #007bff;
  }

  .element-id {
    color: #28a745;
    margin-left: 4px;
  }

  .element-class {
    color: #ffc107;
    margin-left: 4px;
  }

  .element-selector-code {
    font-family: 'Monaco', 'Menlo', monospace;
    background: #f6f8fa;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
    color: #d73a49;
    border: 1px solid #e1e4e8;
  }

  /* 编辑模式按钮样式 */
  .edit-mode-active {
    background-color: #52c41a !important;
    border-color: #52c41a !important;
    color: white !important;
  }

  .edit-mode-active:hover {
    background-color: #73d13d !important;
    border-color: #73d13d !important;
  }
}
</style>
