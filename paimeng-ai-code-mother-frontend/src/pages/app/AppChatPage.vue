<template>
  <div id="appChatPage">
    <header class="workspace-bar">
      <div class="bar-left">
        <a-button type="text" class="back-btn" aria-label="返回首页" @click="goHome">
          <ArrowLeftOutlined />
        </a-button>
        <div class="app-heading">
          <h1>{{ app?.appName || '应用工作台' }}</h1>
          <div class="app-subline">
            <span class="run-pill" :class="runTone">
              <span class="run-dot"></span>
              {{ runLabel }}
            </span>
          </div>
        </div>
      </div>
      <div class="bar-actions">
        <a-button @click="detailOpen = true">应用详情</a-button>
        <a-button v-if="previewUrl" @click="openPreviewWindow">新窗口</a-button>
      </div>
    </header>

    <div v-if="isNarrow" class="mobile-tabs" role="tablist" aria-label="工作台视图">
      <button
        class="mobile-tab"
        :class="{ active: mobileTab === 'chat' }"
        type="button"
        role="tab"
        :aria-selected="mobileTab === 'chat'"
        @click="mobileTab = 'chat'"
      >
        对话
      </button>
      <button
        class="mobile-tab"
        :class="{ active: mobileTab === 'preview' }"
        type="button"
        role="tab"
        :aria-selected="mobileTab === 'preview'"
        @click="mobileTab = 'preview'"
      >
        预览
        <span v-if="previewStatus === 'running'" class="tab-live-dot"></span>
      </button>
    </div>

    <div class="workspace-body">
      <section
        v-show="!isNarrow || mobileTab === 'chat'"
        class="chat-pane"
        :style="isNarrow ? undefined : { width: `${splitWidth}px` }"
      >
        <div ref="messageListRef" class="message-list" @scroll="handleScroll">
          <div v-if="historyLoading" class="list-tip">正在加载对话…</div>
          <div v-else-if="hasMore" class="list-tip">
            <a-button type="link" size="small" @click="loadHistory(false)">加载更早的对话</a-button>
          </div>

          <div v-if="!historyLoading && messages.length === 0" class="empty-chat">
            <span class="empty-mark">✦</span>
            <p class="empty-title">描述你想要的页面</p>
            <p class="empty-desc">AI 会写代码、安装依赖、验证并打开实时预览。</p>
            <div class="empty-examples">
              <button
                v-for="example in emptyExamples"
                :key="example"
                type="button"
                class="empty-example"
                @click="inputMessage = example"
              >
                {{ example }}
              </button>
            </div>
          </div>

          <article
            v-for="item in messages"
            :key="item.key"
            class="message-item"
            :class="item.role === 'user' ? 'message-user' : 'message-assistant'"
          >
            <div v-if="item.role === 'user'" class="user-bubble">{{ item.text }}</div>
            <div v-else class="assistant-doc">
              <button
                class="turn-summary"
                type="button"
                :aria-expanded="isTurnOpen(item)"
                @click="toggleTurn(item)"
              >
                <span class="turn-title">{{ turnLabel(item) }}</span>
                <DownOutlined v-if="isTurnOpen(item)" class="turn-chevron" />
                <RightOutlined v-else class="turn-chevron" />
              </button>

              <div class="turn-body">
                <AgentTurnParts
                  :message="item.message"
                  :status="item.status"
                  :process-expanded="isTurnOpen(item)"
                />
                <p
                  v-if="
                    item.status === 'streaming' && !item.modelProgress && !item.message.parts.length
                  "
                  class="thinking"
                >
                  正在思考…
                </p>
                <p
                  v-if="item.status === 'streaming' && item.modelProgress"
                  class="model-progress"
                  role="status"
                >
                  {{ item.modelProgress }}
                </p>

                <ChangeCard
                  v-if="
                    isTurnOpen(item) && detailsFor(item)?.changes && item.status !== 'streaming'
                  "
                  :changes="detailsFor(item)!.changes"
                  :details-status="detailsFor(item)!.detailsStatus"
                  @open="openChanges(item.runId!)"
                />
                <p
                  v-if="
                    isTurnOpen(item) &&
                    detailsFor(item)?.detailsStatus === 'incomplete' &&
                    detailsFor(item)?.detailsError
                  "
                  class="details-note"
                >
                  {{ detailsFor(item)!.detailsError }}
                </p>
                <p v-if="item.status === 'failed' && errorSummaryFor(item)" class="error-note">
                  {{ errorSummaryFor(item) }}
                </p>
              </div>
            </div>
          </article>
        </div>

        <div class="composer-area">
          <div v-if="showQueuePanel" class="queue-panel" aria-live="polite">
            <div class="queue-head">
              <span class="queue-title">消息队列</span>
              <span class="queue-state">{{ queueStateLabel }}</span>
              <a-button
                v-if="queueState.paused"
                size="small"
                type="link"
                :loading="queueActionBusy"
                @click="resumeQueue"
              >
                <PlayCircleOutlined />
                继续队列
              </a-button>
            </div>
            <div v-for="item in queueItems" :key="item.id" class="queue-item">
              <span class="queue-mode" :class="item.mode">{{
                item.mode === 'steer' ? '插话发送' : '普通'
              }}</span>
              <span class="queue-message">{{ item.message }}</span>
              <span class="queue-status" :class="item.status">{{ queueItemLabel(item) }}</span>
              <a-button
                v-if="item.status === 'returned'"
                size="small"
                type="text"
                :disabled="hasDraftContent || queueActionBusy"
                :title="hasDraftContent ? '当前草稿非空，不能覆盖' : '恢复为草稿'"
                aria-label="恢复为草稿"
                @click="restoreQueueItem(item)"
              >
                <UndoOutlined />
              </a-button>
              <a-button
                v-if="item.status === 'queued' || item.status === 'returned'"
                size="small"
                type="text"
                danger
                :disabled="queueActionBusy"
                title="移出队列"
                aria-label="移出队列"
                @click="removeQueueItem(item)"
              >
                <DeleteOutlined />
              </a-button>
            </div>
          </div>
          <div class="chat-composer">
            <textarea
              v-model="inputMessage"
              :maxlength="1000"
              rows="3"
              placeholder="描述你想做的页面，或继续提出修改…"
              @keydown="handleKeydown"
              @input="handleDraftInput"
            ></textarea>
            <div class="chat-composer-footer">
              <div class="composer-meta">
                <div class="mode-switch" role="group" aria-label="发送模式">
                  <button
                    type="button"
                    :class="{ active: chatMode === 'steer' }"
                    @click="chatMode = 'steer'"
                  >
                    插话发送
                  </button>
                  <button
                    type="button"
                    :class="{ active: chatMode === 'normal' }"
                    @click="chatMode = 'normal'"
                  >
                    普通
                  </button>
                </div>
                <span>{{ inputMessage.length }}/1000 · Enter 当前模式 · Alt+Enter 另一模式</span>
              </div>
              <a-button
                class="composer-action"
                shape="circle"
                :type="composerActionKind === 'send' ? 'primary' : 'default'"
                :danger="composerActionKind === 'stop'"
                :loading="queueSubmitting"
                :disabled="!initialized || composerActionKind === 'disabled' || queueSubmitting"
                :aria-label="composerActionLabel"
                :title="composerActionLabel"
                @click="handleComposerAction"
              >
                <StopOutlined v-if="composerActionKind === 'stop'" />
                <ArrowUpOutlined v-else />
              </a-button>
            </div>
          </div>
        </div>
      </section>

      <div
        v-if="!isNarrow"
        class="splitter"
        role="separator"
        aria-orientation="vertical"
        :aria-valuenow="splitWidth"
        aria-valuemin="320"
        aria-valuemax="560"
        tabindex="0"
        @pointerdown="startDrag"
        @dblclick="resetSplit"
        @keydown="handleSplitterKeydown"
      ></div>

      <section v-show="!isNarrow || mobileTab === 'preview'" class="preview-pane">
        <div class="preview-toolbar">
          <div class="preview-state">
            <span class="preview-dot" :class="`dot-${previewStatus}`"></span>
            <span>{{ previewStatusText }}</span>
            <span v-if="runStatus === 'running'" class="preview-phase">{{ runLabel }}</span>
          </div>
          <div class="preview-actions">
            <div class="viewport-switch" role="group" aria-label="预览宽度">
              <button
                v-for="option in viewportOptions"
                :key="option.value"
                type="button"
                :class="{ active: previewViewport === option.value }"
                @click="previewViewport = option.value"
              >
                {{ option.label }}
              </button>
            </div>
            <a-button size="small" :loading="previewLoading" @click="refreshPreview">刷新</a-button>
          </div>
        </div>

        <div class="preview-stage">
          <div class="preview-card" :class="`viewport-${previewViewport}`">
            <iframe
              v-if="previewSrc"
              :src="previewSrc"
              class="preview-frame"
              sandbox="allow-scripts allow-same-origin allow-forms"
              referrerpolicy="no-referrer"
              title="应用预览"
            ></iframe>
            <div v-else class="preview-placeholder">
              <template v-if="previewStatus === 'failed'">
                <p class="placeholder-title">预览启动失败</p>
                <pre class="placeholder-error">{{ previewError }}</pre>
                <a-button size="small" @click="startPreviewManually">重试启动</a-button>
              </template>
              <template v-else>
                <span class="placeholder-glyph">◌</span>
                <p class="placeholder-title">
                  {{ previewStatus === 'starting' ? '正在启动预览…' : '生成完成后这里会显示应用' }}
                </p>
                <p class="placeholder-desc">每次修改都会在右侧更新。</p>
              </template>
            </div>
          </div>
        </div>
      </section>
    </div>

    <a-drawer v-model:open="changesOpen" title="本轮文件变更" width="520" placement="right">
      <div v-if="changesLoading" class="drawer-tip">正在加载…</div>
      <div v-else-if="!changes.length" class="drawer-tip">本轮没有可展示的文件变更。</div>
      <div v-else class="change-list">
        <button
          v-for="change in changes"
          :key="change.id"
          type="button"
          class="change-row"
          @click="openDiff(change)"
        >
          <span class="change-status" :class="change.status">{{
            changeStatusLabel(change.status)
          }}</span>
          <span class="change-path">{{ change.path }}</span>
          <span class="change-stats">
            <span v-if="change.additions !== null" class="add">+{{ change.additions }}</span>
            <span v-if="change.deletions !== null" class="del">−{{ change.deletions }}</span>
            <span v-if="change.diffStatus === 'binary'">二进制</span>
            <span v-if="change.diffStatus === 'too_large'">过大</span>
          </span>
        </button>
      </div>
    </a-drawer>

    <a-drawer
      v-model:open="diffOpen"
      :title="diffPath || '文件 diff'"
      width="760"
      placement="right"
    >
      <div v-if="diffLoading" class="drawer-tip">正在加载 diff…</div>
      <pre v-else class="diff-view"><code><span
        v-for="(line, index) in diffLines"
        :key="index"
        class="diff-line"
        :class="diffLineClass(line)"
      >{{ line }}
</span></code></pre>
      <a-button v-if="diffCursor" size="small" :loading="diffLoading" @click="loadMoreDiff"
        >加载更多</a-button
      >
    </a-drawer>

    <AppDetailModal
      v-model:open="detailOpen"
      :app="app"
      :show-actions="true"
      @edit="goEdit"
      @delete="handleDelete"
    />
    <iframe
      ref="authFrameRef"
      name="preview-auth-frame"
      class="auth-frame"
      title="预览授权"
      aria-hidden="true"
    ></iframe>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import {
  ArrowLeftOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  DownOutlined,
  PlayCircleOutlined,
  RightOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons-vue'
import AppDetailModal from '@/components/AppDetailModal.vue'
import ChangeCard from '@/components/agent/ChangeCard.vue'
import AgentTurnParts from '@/components/agent/AgentTurnParts.vue'
import { createTaskQueue } from '@/utils/chatCoordinator'
import {
  composerAction,
  createQueuedChatCoordinator,
  draftAfterReturnedRemoval,
  queueItemLabel,
  resolveComposerShortcut,
  returnedItemDraft,
  shouldStartInitialPrompt,
  type EnqueueMessageBody,
} from '@/utils/queuedChatCoordinator'
import { modelProgressText } from '@/utils/modelProgress'
import { applyMessageReplay, assistantMessageId } from '@/utils/chatStream'
import { shouldRefreshPreviewAuth } from '@/utils/previewAuth'
import { type ToolStatus, type ToolTimelineEntry } from '@/utils/agentActivity'
import {
  clampSplitWidth,
  defaultSplitWidth,
  parseStoredSplit,
  SPLIT_STORAGE_KEY,
} from '@/utils/workspace'
import {
  cancelRun,
  enqueueMessage,
  getMessageQueue,
  getRunDetails,
  getRunDiff,
  getRunStatus,
  listRunActivities,
  listRunChanges,
  removeQueuedMessage,
  resumeMessageQueue,
} from '@/api/generated/api/run'
import { deleteApp, getAppVoById } from '@/api/generated/api/app'
import {
  getPreviewStatus,
  requestPreviewAccess,
  sendPreviewHeartbeat,
  startPreview,
} from '@/api/generated/api/preview'
import { listAppChatHistory } from '@/api/generated/api/chatHistory'
import { subscribeRunChat } from '@/api/streamChat'
import type {
  ChatMode,
  ChatStreamEvent,
  ChatUIMessage,
  MessageQueueState,
  QueueItem,
  UIMessageTextPart,
} from '@/api/chatTypes'
import type {
  AppPreview,
  AppVO,
  MessageVO,
  RunActivity,
  RunChange,
  RunDetails,
} from '@/api/apiTypes'

interface ChatItem {
  key: string
  id: number | null
  runId: string | null
  role: 'user' | 'assistant'
  status: 'completed' | 'streaming' | 'failed' | 'cancelled'
  message: ChatUIMessage
  text: string
  errorSummary?: string | null
  activities?: string[]
  toolTimeline?: ToolTimelineEntry[]
  startedAtMs?: number
  modelProgress?: string
}

const route = useRoute()
const router = useRouter()
const appId = Number(route.params.id)
const startRequested = route.query.start === '1'

const app = ref<AppVO>()
const detailOpen = ref(false)
const messages = ref<ChatItem[]>([])
const inputMessage = ref('')
const initialized = ref(false)
const chatMode = ref<ChatMode>('steer')
const queueState = ref<MessageQueueState>({ paused: false, items: [], activeRun: null })
const queueSubmitting = ref(false)
const queueActionBusy = ref(false)
const localReturnedRestores = ref<QueueItem[]>([])
const historyQueue = createTaskQueue()
const historyLoading = ref(false)
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const messageListRef = ref<HTMLElement>()
const runId = ref<string | null>(null)
const runStatus = ref<string>('idle')
const previewSrc = ref('')
const previewStatus = ref<AppPreview['status']>('stopped')
const previewError = ref('')
const previewLoading = ref(false)
const previewUrl = ref('')
const previewViewport = ref<'fill' | 'tablet' | 'mobile'>('fill')
const authFrameRef = ref<HTMLIFrameElement>()
const lastAccessAt = ref(0)
const runDetails = reactive<Record<string, RunDetails>>({})
const terminalRunStatuses = new Map<string, 'completed' | 'failed' | 'cancelled'>()
const activitiesByRun = reactive<Record<string, RunActivity[]>>({})
const activitiesLoading = reactive<Record<string, boolean>>({})
const expandedTurns = ref<string[]>([])
const now = ref(Date.now())
const changesOpen = ref(false)
const changesLoading = ref(false)
const changes = ref<RunChange[]>([])
const changesRunId = ref('')
const diffOpen = ref(false)
const diffLoading = ref(false)
const diffPath = ref('')
const diffLines = ref<string[]>([])
const diffCursor = ref<number | null>(null)
const diffRunId = ref('')
const diffFileId = ref(0)
const splitWidth = ref(400)
const isNarrow = ref(false)
const mobileTab = ref<'chat' | 'preview'>('chat')
const scrollPinned = ref(true)

const emptyExamples = [
  '做一个待办清单，可以添加、勾选和删除任务',
  '做一个个人作品集，包含项目和联系方式',
  '做一个咖啡店官网，包含菜单和门店信息',
]

const viewportOptions = [
  { value: 'fill' as const, label: '自适应' },
  { value: 'tablet' as const, label: '768' },
  { value: 'mobile' as const, label: '390' },
]

const queueItems = computed(() => {
  const items = queueState.value.items.filter(
    (item) => item.status !== 'started' && item.status !== 'removed',
  )
  const ids = new Set(items.map((item) => item.id))
  return [...items, ...localReturnedRestores.value.filter((item) => !ids.has(item.id))]
})
const showQueuePanel = computed(() => queueItems.value.length > 0)
const queueStateLabel = computed(() => {
  if (queueState.value.paused) return '已暂停'
  if (queueState.value.activeRun?.status === 'cancelling') return '正在停止当前轮次'
  if (queueState.value.activeRun) return '当前轮次运行中'
  if (queueItems.value.some((item) => ['queued', 'claimed'].includes(item.status)))
    return '等待发送'
  return queueItems.value.length ? '有消息退回' : '空闲'
})
const hasStoppableRun = computed(() => queueState.value.activeRun?.status === 'running')
const hasDraftContent = computed(() => inputMessage.value.trim().length > 0)
const composerActionKind = computed(() => composerAction(inputMessage.value, hasStoppableRun.value))
const composerActionLabel = computed(() => {
  if (composerActionKind.value === 'send') return '发送消息'
  if (composerActionKind.value === 'stop') return '停止生成'
  return '请先输入内容'
})
const previewStatusText = computed(() => {
  if (previewStatus.value === 'running') return '预览运行中'
  if (previewStatus.value === 'starting') return '预览启动中'
  if (previewStatus.value === 'failed') return '预览启动失败'
  return '预览未启动'
})
const runTone = computed(() => {
  if (runStatus.value === 'completed') return 'success'
  if (runStatus.value === 'failed') return 'danger'
  if (runStatus.value === 'cancelled') return 'muted'
  if (runStatus.value === 'cancelling') return 'warning'
  if (runStatus.value === 'running') return 'running'
  return 'muted'
})
const runLabel = computed(() => {
  if (runStatus.value === 'running') return '生成中'
  if (runStatus.value === 'cancelling') return '正在停止'
  if (runStatus.value === 'completed') return '已完成'
  if (runStatus.value === 'failed') return '生成失败'
  if (runStatus.value === 'cancelled') return '已停止'
  return '准备就绪'
})

let previewTimer: number | null = null
let heartbeatTimer: number | null = null
let authRefreshTimer: number | null = null
let clockTimer: number | null = null
let disposed = false
let dragging = false
let dragStartX = 0
let dragStartWidth = 400
let narrowMedia: MediaQueryList | null = null
let observedActiveRunId = ''
let currentRunFallback: NonNullable<MessageQueueState['activeRun']> | null = null
let initialPromptStarted = false
let historyConfirmed = false
let draftRevision = 0

const detailsFor = (item: ChatItem): RunDetails | undefined =>
  item.runId ? runDetails[item.runId] : undefined

const errorSummaryFor = (item: ChatItem) =>
  item.errorSummary || (item.runId ? runDetails[item.runId]?.errorSummary : null) || ''

const isTurnOpen = (item: ChatItem) =>
  item.status === 'streaming' || expandedTurns.value.includes(item.key)

const durationMs = (item: ChatItem) => {
  const details = detailsFor(item)
  const start = details?.startedAt ? Date.parse(details.startedAt) : (item.startedAtMs ?? NaN)
  const end = details?.finishedAt ? Date.parse(details.finishedAt) : now.value
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
}

const formatDuration = (ms: number) => {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

const turnLabel = (item: ChatItem) => {
  const ms = durationMs(item)
  if (item.status === 'streaming') {
    return ms !== null && ms >= 1000 ? `已处理 ${formatDuration(ms)}` : '处理中'
  }
  const duration = ms !== null ? `用时 ${formatDuration(ms)}` : ''
  if (item.status === 'failed') return duration ? `生成失败 · ${duration}` : '生成失败'
  if (item.status === 'cancelled') return duration ? `已停止 · ${duration}` : '已停止'
  return duration || '本轮已完成'
}

const payloadInput = (payload: Record<string, unknown>): Record<string, unknown> | undefined => {
  const input = payload.input
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined
}

const stringValue = (value: unknown) => (typeof value === 'string' ? value : '')

const pathOf = (input: Record<string, unknown> | undefined, result?: Record<string, unknown>) =>
  stringValue(input?.path) || stringValue(result?.path)

const dependencyText = (input: Record<string, unknown> | undefined) => {
  const action = stringValue(input?.action)
  const packages = Array.isArray(input?.packages)
    ? input.packages
        .map((item) =>
          item && typeof item === 'object'
            ? stringValue((item as Record<string, unknown>).name)
            : '',
        )
        .filter(Boolean)
    : []
  const names = Array.isArray(input?.names) ? input.names.map(String) : []
  if (action === 'add') return packages.length ? packages.join('、') : '依赖'
  if (action === 'remove') return names.length ? names.join('、') : '依赖'
  if (action === 'list_allowed') return '允许依赖'
  if (action === 'list_installed') return '已安装依赖'
  return '依赖'
}

const describeTool = (
  tool: string,
  input: Record<string, unknown> | undefined,
  status: ToolStatus,
  result?: Record<string, unknown>,
  error?: string,
) => {
  const path = pathOf(input, result)
  const pattern = stringValue(input?.pattern)
  const name = stringValue(input?.name)
  let verb = '执行'
  let object = ''
  if (tool === 'read') {
    verb = '读取'
    object = path || '文件'
  } else if (tool === 'write') {
    verb = result?.created === true ? '创建' : '写入'
    object = path || '文件'
  } else if (tool === 'edit') {
    verb = '编辑'
    object = path || '文件'
  } else if (tool === 'delete') {
    verb = '删除'
    object = path || (result?.kind === 'directory' ? '目录' : '文件')
  } else if (tool === 'ls') {
    verb = '查看'
    object = path || '项目目录'
  } else if (tool === 'grep') {
    verb = '搜索'
    object = pattern ? `“${pattern}”` : '项目内容'
  } else if (tool === 'find') {
    verb = '查找'
    object = pattern ? `“${pattern}”` : '文件'
  } else if (tool === 'load_skill') {
    verb = '加载'
    object = name ? `${name} 技能` : '技能'
  } else if (tool === 'read_skill_resource') {
    verb = '读取'
    object = path || '技能资源'
  } else if (tool === 'dependencies') {
    const action = stringValue(input?.action)
    verb =
      action === 'add' ? '添加' : action === 'remove' ? '移除' : action === 'sync' ? '同步' : '查看'
    object = dependencyText(input)
  } else if (tool === 'update_plan') {
    return status === 'running' ? '正在更新计划' : '已更新计划'
  } else if (tool === 'preview') {
    return status === 'running' ? '正在检查预览' : '已检查预览'
  }
  const needsSpace = /^[A-Za-z0-9_./@-]/.test(object) || object.startsWith('“')
  const phrase = needsSpace ? `${verb} ${object}` : `${verb}${object}`
  if (status === 'running') return `正在${phrase}`
  if (status === 'failed') return `未能${phrase}${error ? `：${error}` : ''}`
  if (status === 'stopped') return `${phrase}未完成`
  return `已${phrase}`
}

const timelineFromActivities = (activities: RunActivity[]): ToolTimelineEntry[] => {
  const starts = new Map<string, { tool: string; input?: Record<string, unknown> }>()
  const finishes = new Map<
    string,
    { tool: string; status: ToolStatus; result?: Record<string, unknown>; error?: string }
  >()
  const finishOrder: string[] = []
  for (const activity of activities) {
    const payload = activity.payload
    if (activity.type === 'tool-started') {
      const id = stringValue(payload.toolCallId) || `tool-${activity.id}`
      const tool = stringValue(payload.tool) || '工具'
      const input = payloadInput(payload)
      if (!starts.has(id)) starts.set(id, { tool, input })
      continue
    }
    if (activity.type !== 'tool-finished') continue
    const id = stringValue(payload.toolCallId)
    if (!id) continue
    const tool = stringValue(payload.tool) || '工具'
    const ok = payload.ok !== false && !payload.error
    const error = payload.error ? String(payload.error) : undefined
    const result =
      payload.result && typeof payload.result === 'object'
        ? (payload.result as Record<string, unknown>)
        : undefined
    if (!finishes.has(id)) {
      finishes.set(id, { tool, status: ok ? 'done' : 'failed', result, error })
      finishOrder.push(id)
    }
  }
  const entries: ToolTimelineEntry[] = []
  for (const [id, start] of starts) {
    const finish = finishes.get(id)
    const status: ToolStatus = finish?.status ?? 'running'
    entries.push({
      id,
      tool: start.tool,
      input: start.input,
      label: describeTool(start.tool, start.input, status, finish?.result, finish?.error),
      status,
      error: finish?.error,
    })
  }
  for (const id of finishOrder) {
    if (starts.has(id)) continue
    const finish = finishes.get(id)!
    entries.push({
      id,
      tool: finish.tool,
      label: describeTool(finish.tool, undefined, finish.status, finish.result, finish.error),
      status: finish.status,
      error: finish.error,
    })
  }
  return entries
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const timelineFor = (item: ChatItem): ToolTimelineEntry[] => {
  if (item.runId && activitiesByRun[item.runId]) {
    return timelineFromActivities(activitiesByRun[item.runId])
  }
  if (item.toolTimeline?.length) return item.toolTimeline
  if (!item.runId) {
    return (item.activities ?? []).map((label, index) => ({
      id: `summary-${index}`,
      tool: 'tool',
      label,
      status: label.includes('失败') ? 'failed' : 'done',
    }))
  }
  return []
}

const handleScroll = () => {
  const el = messageListRef.value
  if (!el) return
  scrollPinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

const scrollToBottom = () => {
  if (!scrollPinned.value) return
  requestAnimationFrame(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const loadDetails = async (id: string | null, force = false) => {
  if (!id || (!force && runDetails[id])) return
  try {
    const res = await getRunDetails({ runId: id })
    if (res.data.code === 0 && res.data.data) runDetails[id] = res.data.data
  } catch {
    // 详情失败不清空已显示内容
  }
}

const loadHistory = (reset: boolean): Promise<boolean> =>
  historyQueue.run(async () => {
    if (disposed) return false
    historyLoading.value = true
    const requestedRunId = runId.value
    try {
      const res = await listAppChatHistory({
        appId,
        cursor: reset ? undefined : (nextCursor.value ?? undefined),
        pageSize: 20,
      })
      if (res.data.code !== 0 || !res.data.data)
        throw new Error(res.data.message || '历史消息返回异常')
      if (disposed) return false
      const records = res.data.data.records.map(toChatItem)
      const existingIds = new Set(messages.value.map((item) => item.id))
      messages.value = reset
        ? records
        : [...records.filter((item) => !existingIds.has(item.id)), ...messages.value]
      nextCursor.value = res.data.data.nextCursor ?? null
      hasMore.value = res.data.data.hasMore
      if (reset) {
        scrollPinned.value = true
        scrollToBottom()
      }
      if (reset && !queueState.value.activeRun && runId.value === requestedRunId) {
        const lastRun = [...messages.value]
          .reverse()
          .find((item) => item.role === 'assistant' && item.runId)
        if (lastRun) {
          runId.value = lastRun.runId ?? ''
          runStatus.value =
            terminalRunStatuses.get(lastRun.runId ?? '') ??
            (lastRun.status === 'completed'
              ? 'completed'
              : lastRun.status === 'cancelled'
                ? 'cancelled'
                : lastRun.status === 'failed'
                  ? 'failed'
                  : 'running')
        }
      }
      const ids = [...new Set(messages.value.map((item) => item.runId).filter(Boolean))].slice(-10)
      for (const id of ids) void loadDetails(id as string)
      return true
    } catch {
      if (messages.value.length === 0) message.error('加载对话失败')
      return false
    } finally {
      historyLoading.value = false
    }
  })

const uiText = (message: ChatUIMessage | undefined) =>
  (message?.parts ?? [])
    .filter((part): part is UIMessageTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')

const toChatItem = (item: MessageVO): ChatItem => {
  const message: ChatUIMessage = item.content ?? {
    id: `${item.role}:${item.runId ?? item.id}`,
    role: item.role,
    parts: [],
  }
  return {
    key: `m-${item.id}`,
    id: item.id,
    runId: item.runId,
    role: item.role,
    status: item.status,
    message,
    text: uiText(message),
    startedAtMs: item.status === 'streaming' ? Date.now() : undefined,
  }
}

const loadApp = async () => {
  try {
    const res = await getAppVoById({ id: appId })
    if (res.data.code !== 0 || !res.data.data) {
      message.error(res.data.message || '应用不存在')
      await router.push('/')
      return
    }
    app.value = res.data.data
    previewStatus.value = res.data.data.preview?.status ?? 'stopped'
    previewError.value = res.data.data.preview?.lastError ?? ''
    const current = res.data.data.currentRun
    if (current && (current.status === 'running' || current.status === 'cancelling')) {
      runId.value = current.runId
      runStatus.value = current.status
      currentRunFallback = { runId: current.runId, status: current.status }
    } else if (previewStatus.value === 'running') {
      await attachPreview()
    }
  } catch {
    message.error('加载应用失败')
    await router.push('/')
  }
}

const ensureAssistantItem = (id: string): ChatItem => {
  const streamId = assistantMessageId(id)
  const existing = messages.value.find(
    (item) => item.role === 'assistant' && (item.runId === id || item.message.id === streamId),
  )
  if (existing) {
    existing.runId = id
    return existing
  }
  const item: ChatItem = {
    key: `stream-${streamId}`,
    id: null,
    runId: id,
    role: 'assistant',
    status: 'streaming',
    message: { id: streamId, role: 'assistant', parts: [] },
    text: '',
    startedAtMs: Date.now(),
  }
  messages.value.push(item)
  return item
}

const handleRunMessage = (id: string, uiMessage: ChatUIMessage) => {
  if (queueState.value.activeRun && queueState.value.activeRun.runId !== id) return
  const replay = applyMessageReplay(
    messages.value,
    id,
    uiMessage,
    (): ChatItem => ({
      key: `stream-${assistantMessageId(id)}`,
      id: null,
      runId: id,
      role: 'assistant',
      status: 'streaming',
      message: { id: assistantMessageId(id), role: 'assistant', parts: [] },
      text: '',
      startedAtMs: Date.now(),
    }),
  )
  messages.value = replay.items
  const item = replay.item
  item.text = uiText(item.message)
  const terminalStatus = terminalRunStatuses.get(id)
  item.status = terminalStatus ?? 'streaming'
  item.modelProgress = terminalStatus ? '' : item.modelProgress
  runId.value = id
  runStatus.value = terminalStatus ?? 'running'
  scrollToBottom()
}

const handleEvent = (event: ChatStreamEvent) => {
  if (event.type === 'run-started') {
    if (terminalRunStatuses.has(event.runId)) return
    runId.value = event.runId
    runStatus.value = 'running'
    const item = messages.value.find(
      (entry) => entry.role === 'assistant' && entry.runId === event.runId,
    )
    if (item) item.message = { ...item.message, id: assistantMessageId(event.runId) }
    return
  }
  if (event.type === 'model-status') {
    ensureAssistantItem(event.runId).modelProgress = modelProgressText(event.payload)
    return
  }
  if (event.type === 'plan-updated') {
    void loadDetails(event.runId, true)
    return
  }
  if (event.type === 'validation-status') {
    void loadDetails(event.runId, true)
    return
  }
  if (event.type === 'preview-status') {
    const status = String(event.payload.status ?? '')
    if (status === 'running' || status === 'starting' || status === 'failed') {
      previewStatus.value = status as AppPreview['status']
      if (status === 'failed') previewError.value = String(event.payload.error ?? '')
    }
    return
  }
  if (event.type === 'run-finished') {
    const status =
      event.payload.status === 'completed' || event.payload.status === 'cancelled'
        ? event.payload.status
        : 'failed'
    terminalRunStatuses.set(event.runId, status)
    if (runId.value === event.runId || (!runId.value && !queueState.value.activeRun)) {
      runId.value = event.runId
      runStatus.value = status
    }
    const item = ensureAssistantItem(event.runId)
    item.modelProgress = ''
    item.status =
      status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed'
    item.errorSummary = (event.payload.errorSummary as string | null) ?? null
    void loadDetails(event.runId, true)
    void loadHistory(true)
    void syncPreview()
  }
}

const queueErrorMessage = (error: unknown, fallback: string) => {
  const detail = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
  return detail || (error instanceof Error ? error.message : fallback)
}

const knownQueueError = (detail: string) => Object.assign(new Error(detail), { knownOutcome: true })

const queuedChatCoordinator = createQueuedChatCoordinator<ChatStreamEvent>({
  appId,
  createRequestId: () => crypto.randomUUID(),
  enqueue: async (body: EnqueueMessageBody) => {
    const res = await enqueueMessage(body)
    if (res.data.code !== 0 || !res.data.data) {
      throw Object.assign(new Error(res.data.message || '消息入队失败'), { response: res })
    }
    return res.data.data
  },
  getQueue: async (id) => {
    const res = await getMessageQueue({ appId: id })
    if (res.data.code !== 0 || !res.data.data) {
      throw knownQueueError(res.data.message || '消息队列读取失败')
    }
    return res.data.data
  },
  findRunByRequest: async (id, clientRequestId) => {
    const res = await getRunStatus({ appId: id, clientRequestId })
    if (res.data.code !== 0 || !res.data.data) {
      throw knownQueueError(res.data.message || '运行状态确认失败')
    }
    return {
      runId: res.data.data.runId,
      status: res.data.data.status,
      errorSummary: res.data.data.errorSummary,
    }
  },
  findQueueItemByRequest: async (id, clientRequestId) => {
    const res = await getMessageQueue({ appId: id, clientRequestId })
    if (res.data.code !== 0 || !res.data.data) {
      throw knownQueueError(res.data.message || '消息状态确认失败')
    }
    return res.data.data.requestedItem ?? null
  },
  remove: async (id, itemId) => {
    const res = await removeQueuedMessage({ appId: id, id: itemId })
    if (res.data.code !== 0) throw knownQueueError(res.data.message || '移出队列失败')
  },
  resume: async (id) => {
    const res = await resumeMessageQueue({ appId: id })
    if (res.data.code !== 0 || !res.data.data) {
      throw knownQueueError(res.data.message || '继续队列失败')
    }
    return res.data.data
  },
  cancel: async (id) => {
    const res = await cancelRun({ runId: id })
    if (res.data.code !== 0) throw knownQueueError(res.data.message || '停止失败，请重试')
  },
  reconcile: async (id) => {
    const res = await getRunStatus({ runId: id })
    if (res.data.code !== 0 || !res.data.data) {
      throw knownQueueError(res.data.message || '旧运行状态确认失败')
    }
    return {
      runId: id,
      status: res.data.data.status,
      errorSummary: res.data.data.errorSummary,
    }
  },
  subscribe: (id, handlers, signal) => subscribeRunChat({ runId: id }, handlers, signal),
  changed: (next) => {
    queueState.value = next
    if (next.activeRun) {
      runId.value = next.activeRun.runId
      runStatus.value = terminalRunStatuses.get(next.activeRun.runId) ?? next.activeRun.status
      if (next.activeRun.runId !== observedActiveRunId) {
        observedActiveRunId = next.activeRun.runId
        void loadHistory(true)
      }
    } else {
      observedActiveRunId = ''
    }
    void maybeStartInitialPrompt()
  },
  message: handleRunMessage,
  event: (_, event) => handleEvent(event),
  reconciled: (result) => {
    handleEvent({
      runId: result.runId,
      type: 'run-finished',
      payload: {
        status: result.status,
        errorSummary: result.errorSummary,
      },
    })
  },
  error: (error) => message.error(error.message),
})

const sendMessage = async (textOverride?: string, mode: ChatMode = chatMode.value) => {
  if (!initialized.value || queueSubmitting.value) return
  const draft = typeof textOverride === 'string' ? textOverride : inputMessage.value
  const text = draft.trim()
  if (!text) return
  if (text.length > 1000) return message.warning('消息最多 1000 个字符')
  queueSubmitting.value = true
  scrollPinned.value = true
  try {
    await queuedChatCoordinator.enqueue({ appId, message: text, mode })
    if (inputMessage.value === draft) inputMessage.value = ''
    scrollToBottom()
  } catch (error) {
    message.error(queueErrorMessage(error, '消息发送失败'))
  } finally {
    queueSubmitting.value = false
  }
}

const maybeStartInitialPrompt = async () => {
  if (
    !shouldStartInitialPrompt({
      pending: startRequested,
      started: initialPromptStarted,
      initialized: initialized.value,
      historyLoading: historyLoading.value,
      historyConfirmed,
      queueConfirmed: queuedChatCoordinator.isQueueConfirmed(),
      messageCount: messages.value.length,
      paused: queueState.value.paused,
      activeRun: queueState.value.activeRun,
      queueItemCount: queueItems.value.length,
      initPrompt: app.value?.initPrompt,
    })
  ) {
    return
  }
  initialPromptStarted = true
  await sendMessage(app.value!.initPrompt)
}

const stopCurrentRun = async () => {
  try {
    await queuedChatCoordinator.stop()
  } catch (error) {
    message.error(queueErrorMessage(error, '停止失败，请重试'))
  }
}

const handleComposerAction = () => {
  if (composerActionKind.value === 'send') void sendMessage()
  else if (composerActionKind.value === 'stop') void stopCurrentRun()
}

const handleKeydown = (event: KeyboardEvent) => {
  const shortcut = resolveComposerShortcut(event, inputMessage.value, chatMode.value)
  if (shortcut.type !== 'submit') return
  event.preventDefault()
  void sendMessage(undefined, shortcut.mode)
}

const handleDraftInput = () => {
  draftRevision += 1
}

const removeQueueItem = async (item: QueueItem, showError = true): Promise<boolean> => {
  queueActionBusy.value = true
  try {
    const localOnly =
      localReturnedRestores.value.some((entry) => entry.id === item.id) &&
      !queueState.value.items.some((entry) => entry.id === item.id)
    if (!localOnly) await queuedChatCoordinator.remove(item.id)
    localReturnedRestores.value = localReturnedRestores.value.filter(
      (entry) => entry.id !== item.id,
    )
    return true
  } catch (error) {
    if (showError) message.error(queueErrorMessage(error, '移出队列失败'))
    return false
  } finally {
    queueActionBusy.value = false
  }
}

const resumeQueue = async () => {
  queueActionBusy.value = true
  try {
    await queuedChatCoordinator.resume()
  } catch (error) {
    message.error(queueErrorMessage(error, '继续队列失败'))
  } finally {
    queueActionBusy.value = false
  }
}

const restoreQueueItem = async (item: QueueItem) => {
  const originalDraft = inputMessage.value
  const draft = returnedItemDraft(originalDraft, item)
  if (draft === null) {
    if (hasDraftContent.value) message.info('请先发送或清空当前草稿，再恢复退回的消息')
    return false
  }

  const revision = draftRevision
  localReturnedRestores.value = [
    ...localReturnedRestores.value.filter((entry) => entry.id !== item.id),
    item,
  ]
  const removed = await removeQueueItem(item, false)
  if (!removed) {
    message.error('恢复暂时未完成，消息已保留在恢复项中，可稍后重试')
    return false
  }

  const resolution = draftAfterReturnedRemoval(
    originalDraft,
    draft,
    inputMessage.value,
    draftRevision !== revision,
  )
  if (resolution.draft !== null) inputMessage.value = resolution.draft
  if (!resolution.retainLocal) {
    localReturnedRestores.value = localReturnedRestores.value.filter(
      (entry) => entry.id !== item.id,
    )
  } else {
    localReturnedRestores.value = [
      ...localReturnedRestores.value.filter((entry) => entry.id !== item.id),
      item,
    ]
    message.info('消息已从队列移除并保留在恢复项中，当前草稿未被覆盖')
  }
  return true
}

const loadActivities = async (id: string) => {
  if (activitiesByRun[id] || activitiesLoading[id]) return
  activitiesLoading[id] = true
  try {
    const res = await listRunActivities({ runId: id, limit: 200 })
    activitiesByRun[id] = res.data.data ?? []
  } catch {
    activitiesByRun[id] = []
  } finally {
    activitiesLoading[id] = false
  }
}

const toggleTurn = async (item: ChatItem) => {
  if (item.status === 'streaming') return
  const index = expandedTurns.value.indexOf(item.key)
  if (index >= 0) {
    expandedTurns.value.splice(index, 1)
    return
  }
  expandedTurns.value.push(item.key)
  if (item.runId) {
    void loadDetails(item.runId)
    void loadActivities(item.runId)
  }
}

const openChanges = async (id: string) => {
  changesOpen.value = true
  changesLoading.value = true
  changes.value = []
  changesRunId.value = id
  try {
    const res = await listRunChanges({ runId: id, limit: 100 })
    changes.value = res.data.data?.records ?? []
  } catch {
    message.error('文件变更加载失败')
  } finally {
    changesLoading.value = false
  }
}

const openDiff = async (change: RunChange) => {
  diffOpen.value = true
  diffPath.value = change.path
  diffRunId.value = changesRunId.value
  diffFileId.value = change.id
  diffLines.value = []
  diffCursor.value = null
  diffLoading.value = true
  try {
    const response = await getRunDiff({ runId: diffRunId.value, fileId: change.id })
    if (response.data.data) {
      diffLines.value = response.data.data.lines
      diffCursor.value = response.data.data.nextCursor
        ? Number(response.data.data.nextCursor)
        : null
    }
  } catch {
    message.error('diff 加载失败')
  } finally {
    diffLoading.value = false
  }
}

const loadMoreDiff = async () => {
  if (!diffCursor.value || !diffRunId.value) return
  diffLoading.value = true
  try {
    const res = await getRunDiff({
      runId: diffRunId.value,
      fileId: diffFileId.value,
      cursor: diffCursor.value ?? undefined,
    })
    if (res.data.data) {
      diffLines.value = [...diffLines.value, ...res.data.data.lines]
      diffCursor.value = res.data.data.nextCursor ? Number(res.data.data.nextCursor) : null
    }
  } finally {
    diffLoading.value = false
  }
}

const diffLineClass = (line: string) => {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}

const changeStatusLabel = (status: RunChange['status']) => {
  if (status === 'added') return '新增'
  if (status === 'deleted') return '删除'
  if (status === 'modified') return '修改'
  return status
}

const clampWidth = (value: number) => {
  return clampSplitWidth(value, window.innerWidth)
}

const restoreSplit = () => {
  splitWidth.value = parseStoredSplit(localStorage.getItem(SPLIT_STORAGE_KEY), window.innerWidth)
}

const startDrag = (event: PointerEvent) => {
  if (isNarrow.value) return
  dragging = true
  dragStartX = event.clientX
  dragStartWidth = splitWidth.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  document.body.classList.add('pm-dragging')
}

const handlePointerMove = (event: PointerEvent) => {
  if (!dragging) return
  splitWidth.value = clampWidth(dragStartWidth + event.clientX - dragStartX)
}

const endDrag = () => {
  if (!dragging) return
  dragging = false
  document.body.classList.remove('pm-dragging')
  localStorage.setItem(SPLIT_STORAGE_KEY, String(splitWidth.value))
}

const resetSplit = () => {
  splitWidth.value = clampWidth(defaultSplitWidth(window.innerWidth))
  localStorage.setItem(SPLIT_STORAGE_KEY, String(splitWidth.value))
}

const handleSplitterKeydown = (event: KeyboardEvent) => {
  const step = event.shiftKey ? 64 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    splitWidth.value = clampWidth(splitWidth.value - step)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    splitWidth.value = clampWidth(splitWidth.value + step)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    resetSplit()
  }
}

const requestAndSubmitTicket = async () => {
  const res = await requestPreviewAccess({ appId })
  if (res.data.code !== 0 || !res.data.data) throw new Error(res.data.message || '预览授权失败')
  const { url, ticket } = res.data.data
  previewUrl.value = url
  await submitPreviewTicket(url, ticket.ticket)
  lastAccessAt.value = Date.now()
  startHeartbeat()
}

const applyPreviewAccess = async () => {
  previewLoading.value = true
  try {
    await requestAndSubmitTicket()
    previewSrc.value = `${previewUrl.value}/?__pm_refresh=${Date.now()}`
    previewStatus.value = 'running'
  } catch (error) {
    message.error(error instanceof Error ? error.message : '预览授权失败')
  } finally {
    previewLoading.value = false
  }
}

const refreshPreviewAuth = async () => {
  if (!previewSrc.value) {
    await applyPreviewAccess()
    return
  }
  try {
    await requestAndSubmitTicket()
  } catch {
    message.warning('预览授权续期失败，请刷新页面重新打开预览')
  }
}

const submitPreviewTicket = async (url: string, ticket: string) => {
  await nextTick()
  const frame = authFrameRef.value
  if (!frame) throw new Error('预览授权 frame 未就绪')
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      frame.removeEventListener('load', onLoad)
      resolve()
    }
    const onLoad = () => finish()
    const timer = window.setTimeout(finish, 3000)
    frame.addEventListener('load', onLoad)
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = `${url}/__platform/access`
    form.target = 'preview-auth-frame'
    form.style.display = 'none'
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = 'ticket'
    input.value = ticket
    form.appendChild(input)
    document.body.appendChild(form)
    form.submit()
    form.remove()
  })
}

const syncPreview = async () => {
  try {
    const res = await getPreviewStatus({ appId })
    if (res.data.code !== 0 || !res.data.data) return
    previewStatus.value = res.data.data.status
    previewError.value = res.data.data.lastError ?? ''
    if (res.data.data.status === 'running') {
      if (!previewSrc.value) await applyPreviewAccess()
    } else if (res.data.data.status === 'starting') {
      schedulePreviewPoll()
    }
  } catch {
    // 保留当前显示
  }
}

const schedulePreviewPoll = () => {
  if (previewTimer) window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(async () => {
    await syncPreview()
    if (previewStatus.value === 'starting') schedulePreviewPoll()
  }, 1500)
}

const startPreviewManually = async () => {
  previewLoading.value = true
  try {
    const res = await startPreview({ appId })
    if (res.data.code === 0 && res.data.data) {
      previewStatus.value = res.data.data.status as AppPreview['status']
      previewError.value = res.data.data.error ?? ''
      if (res.data.data.status === 'running') await applyPreviewAccess()
      else if (res.data.data.status === 'starting') schedulePreviewPoll()
    }
  } catch {
    message.error('启动预览失败')
  } finally {
    previewLoading.value = false
  }
}

const refreshPreview = async () => {
  if (!previewUrl.value) {
    await syncPreview()
    return
  }
  await applyPreviewAccess()
}

const startHeartbeat = () => {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer)
  heartbeatTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible')
      void sendPreviewHeartbeat({ appId }).catch(() => undefined)
  }, 30_000)
}

const startAuthRefresh = () => {
  if (authRefreshTimer) window.clearInterval(authRefreshTimer)
  authRefreshTimer = window.setInterval(() => {
    if (
      !shouldRefreshPreviewAuth({
        visible: document.visibilityState === 'visible',
        hasPreview: Boolean(previewSrc.value),
        lastAccessAt: lastAccessAt.value,
        now: Date.now(),
      })
    ) {
      return
    }
    void refreshPreviewAuth()
  }, 60_000)
}

const attachPreview = async () => {
  if (previewSrc.value) return
  await applyPreviewAccess()
}

const openPreviewWindow = () => {
  if (previewUrl.value) window.open(previewUrl.value, '_blank', 'noopener')
}

const goHome = () => router.push('/')
const goEdit = () => router.push(`/app/edit/${appId}`)

const handleDelete = async () => {
  try {
    const res = await deleteApp({ id: appId })
    if (res.data.code === 0) {
      message.success('应用已删除')
      await router.push('/')
    } else {
      message.error(res.data.message || '删除失败')
    }
  } catch (error) {
    const detail = (error as { response?: { data?: { message?: string } } })?.response?.data
      ?.message
    message.error(detail || '删除失败')
  }
}

const handleVisibility = () => {
  if (
    !shouldRefreshPreviewAuth({
      visible: document.visibilityState === 'visible',
      hasPreview: Boolean(previewSrc.value),
      lastAccessAt: lastAccessAt.value,
      now: Date.now(),
    })
  ) {
    return
  }
  void refreshPreviewAuth()
}

const handleResize = () => {
  isNarrow.value = window.matchMedia('(max-width: 1023px)').matches
  if (!isNarrow.value) splitWidth.value = clampWidth(splitWidth.value)
}

onMounted(async () => {
  narrowMedia = window.matchMedia('(max-width: 1023px)')
  isNarrow.value = narrowMedia.matches
  narrowMedia.addEventListener('change', handleResize)
  handleResize()
  restoreSplit()
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  window.addEventListener('resize', handleResize)
  await loadApp()
  historyConfirmed = await loadHistory(true)
  if (currentRunFallback) {
    observedActiveRunId = currentRunFallback.runId
    queuedChatCoordinator.observeActiveRun(currentRunFallback)
  }
  try {
    await queuedChatCoordinator.refresh()
  } catch (error) {
    message.error(queueErrorMessage(error, '消息队列读取失败'))
  }
  if (disposed) return
  initialized.value = true
  startAuthRefresh()
  clockTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
  document.addEventListener('visibilitychange', handleVisibility)
  if (startRequested) await router.replace({ path: route.path, query: {} })
  await maybeStartInitialPrompt()
})

onBeforeUnmount(() => {
  disposed = true
  queuedChatCoordinator.dispose()
  if (previewTimer) window.clearTimeout(previewTimer)
  if (heartbeatTimer) window.clearInterval(heartbeatTimer)
  if (authRefreshTimer) window.clearInterval(authRefreshTimer)
  if (clockTimer) window.clearInterval(clockTimer)
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  window.removeEventListener('resize', handleResize)
  narrowMedia?.removeEventListener('change', handleResize)
  document.removeEventListener('visibilitychange', handleVisibility)
  document.body.classList.remove('pm-dragging')
})
</script>

<style scoped>
#appChatPage {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--pm-page);
  overflow: hidden;
}

.workspace-bar {
  height: 64px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 18px;
  border-bottom: 1px solid var(--pm-line);
  background: color-mix(in srgb, var(--pm-page) 94%, transparent);
  backdrop-filter: blur(12px);
  z-index: 10;
}

.bar-left,
.bar-actions,
.app-heading {
  display: flex;
  align-items: center;
}

.bar-left {
  gap: 8px;
  min-width: 0;
}

.bar-actions {
  gap: 8px;
  flex: 0 0 auto;
}

.back-btn {
  color: var(--pm-ink-2);
}

.app-heading {
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.app-heading h1 {
  margin: 0;
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pm-ink);
  font-size: 15px;
  font-weight: 650;
}

.app-subline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.run-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pm-ink-3);
  font-size: 10px;
}

.run-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.run-pill.running {
  color: var(--pm-warning);
}

.run-pill.success {
  color: var(--pm-success);
}

.run-pill.danger {
  color: var(--pm-danger);
}

.run-pill.warning {
  color: var(--pm-warning);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  display: flex;
  padding: 14px;
  gap: 0;
}

.chat-pane {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--pm-surface);
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-lg);
  overflow: hidden;
}

.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 18px 8px;
  scroll-behavior: smooth;
}

.list-tip {
  text-align: center;
  color: var(--pm-ink-3);
  font-size: 12px;
  padding: 8px 0;
}

.empty-chat {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}

.empty-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: var(--pm-canvas);
  color: var(--pm-brand-strong);
  font-size: 22px;
  margin-bottom: 14px;
}

.empty-title {
  margin: 0;
  color: var(--pm-ink);
  font-size: 17px;
  font-weight: 650;
}

.empty-desc {
  margin: 7px 0 18px;
  color: var(--pm-ink-3);
  font-size: 13px;
}

.empty-examples {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
}

.empty-example {
  border: 1px solid var(--pm-line);
  border-radius: 10px;
  background: transparent;
  color: var(--pm-ink-2);
  padding: 9px 11px;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.empty-example:hover {
  background: var(--pm-canvas);
  color: var(--pm-ink);
}

.message-item {
  margin-bottom: 18px;
}

.message-user {
  display: flex;
  justify-content: flex-end;
}

.user-bubble {
  max-width: 86%;
  padding: 10px 13px;
  border-radius: 14px 14px 4px 14px;
  background: var(--pm-canvas);
  color: var(--pm-ink);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.assistant-doc {
  min-width: 0;
}

.turn-summary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 3px -4px;
  padding: 3px 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--pm-ink-3);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.turn-summary:hover {
  background: var(--pm-canvas);
  color: var(--pm-ink-2);
}

.turn-title {
  font-weight: 550;
}

.turn-chevron {
  margin-left: 1px;
  font-size: 9px;
}

.turn-body {
  padding: 7px 0 0 19px;
}

.turn-timeline {
  display: grid;
  gap: 2px;
  margin: 14px 0 10px;
  padding-top: 8px;
  border-top: 1px solid var(--pm-line);
}

.activity-group {
  border-radius: 8px;
}

.activity-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--pm-ink-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.activity-group-head:hover {
  background: var(--pm-canvas);
}

.activity-group-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--pm-ink-3);
  font-size: 12px;
}

.activity-group.running .activity-group-icon {
  color: var(--pm-brand-strong);
}

.activity-group.failed .activity-group-icon,
.activity-group.failed .activity-group-title {
  color: var(--pm-danger);
}

.activity-group.stopped .activity-group-icon {
  color: var(--pm-warning);
}

.activity-group-title {
  font-weight: 550;
}

.activity-group-chevron {
  margin-left: auto;
  color: var(--pm-ink-3);
  font-size: 9px;
}

.activity-group-body {
  display: grid;
  gap: 1px;
  margin: 1px 0 4px 13px;
  padding-left: 11px;
  border-left: 1px solid var(--pm-line);
}

.turn-activity {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 5px 6px;
  border-radius: 6px;
  color: var(--pm-ink-2);
  font-size: 12px;
  line-height: 1.5;
}

.turn-activity:hover {
  background: var(--pm-canvas);
}

.turn-activity.running .activity-icon {
  color: var(--pm-brand-strong);
}

.activity-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--pm-ink-3);
  font-size: 11px;
}

.activity-icon.failed {
  color: var(--pm-danger);
}

.activity-icon.stopped {
  color: var(--pm-warning);
}

.activity-text {
  min-width: 0;
  word-break: break-word;
}

.activity-state {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--pm-danger);
  font-size: 10px;
}

.thinking {
  margin: 2px 0 6px;
  color: var(--pm-ink-3);
  font-size: 13px;
}

.model-progress,
.pending-message {
  margin: 6px 0;
  color: var(--pm-ink-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.activity-loading {
  margin: 10px 0;
  color: var(--pm-ink-3);
  font-size: 11px;
}

.details-note,
.error-note {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.details-note {
  color: var(--pm-warning);
  background: var(--pm-warning-bg);
}

.error-note {
  color: var(--pm-danger);
  background: var(--pm-danger-bg);
}

.composer-area {
  flex: 0 0 auto;
  padding: 10px 14px 14px;
  border-top: 1px solid var(--pm-line);
  background: var(--pm-surface);
}

.queue-panel {
  display: grid;
  gap: 6px;
  margin-bottom: 8px;
  padding: 9px 10px;
  border: 1px solid var(--pm-line);
  border-radius: 12px;
  background: var(--pm-surface-subtle);
}

.queue-head,
.queue-item,
.composer-meta {
  display: flex;
  align-items: center;
}

.queue-head {
  gap: 8px;
  min-width: 0;
  color: var(--pm-ink-2);
  font-size: 11px;
}

.queue-title {
  color: var(--pm-ink);
  font-weight: 650;
}

.queue-state {
  flex: 1;
  color: var(--pm-ink-3);
}

.queue-head :deep(.ant-btn) {
  height: 22px;
  padding: 0 3px;
  font-size: 11px;
}

.queue-item {
  gap: 7px;
  min-width: 0;
  padding-top: 6px;
  border-top: 1px solid var(--pm-line);
  color: var(--pm-ink-2);
  font-size: 11px;
}

.queue-mode {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--pm-canvas);
  color: var(--pm-ink-3);
  font-size: 10px;
}

.queue-mode.steer {
  color: var(--pm-brand-strong);
}

.queue-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-status {
  flex: 0 0 auto;
  color: var(--pm-ink-3);
  font-size: 10px;
}

.queue-status.returned {
  color: var(--pm-warning);
}

.queue-item :deep(.ant-btn) {
  flex: 0 0 auto;
  width: 22px;
  min-width: 22px;
  height: 22px;
  padding: 0;
}

.chat-composer {
  border: 1px solid var(--pm-line);
  border-radius: 14px;
  background: var(--pm-page);
  padding: 8px;
}

.chat-composer textarea {
  width: 100%;
  min-height: 62px;
  max-height: 180px;
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--pm-ink);
  padding: 6px 8px;
  font-size: 13px;
  line-height: 1.6;
}

.chat-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--pm-ink-3);
  font-size: 10px;
  padding: 2px 4px 0 8px;
}

.composer-meta {
  min-width: 0;
  gap: 8px;
}

.composer-meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-switch {
  flex: 0 0 auto;
  display: flex;
  border: 1px solid var(--pm-line);
  border-radius: 7px;
  overflow: hidden;
}

.mode-switch button {
  border: 0;
  background: transparent;
  color: var(--pm-ink-3);
  padding: 3px 7px;
  font-size: 10px;
  cursor: pointer;
}

.mode-switch button.active {
  background: var(--pm-canvas);
  color: var(--pm-ink);
}

.composer-action {
  flex: 0 0 auto;
}

.splitter {
  flex: 0 0 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
}

.splitter::after {
  content: '';
  width: 2px;
  height: 36px;
  border-radius: 999px;
  background: var(--pm-line-strong);
  transition: background 140ms ease;
}

.splitter:hover::after,
.splitter:focus-visible::after {
  background: var(--pm-brand);
}

.splitter:focus-visible {
  outline: none;
}

:global(body.pm-dragging) {
  cursor: col-resize;
  user-select: none;
}

:global(body.pm-dragging) iframe {
  pointer-events: none;
}

.preview-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--pm-surface);
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-lg);
  overflow: hidden;
}

.preview-toolbar {
  height: 42px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--pm-line);
}

.preview-state,
.preview-actions,
.viewport-switch {
  display: flex;
  align-items: center;
}

.preview-state {
  gap: 7px;
  color: var(--pm-ink-2);
  font-size: 11px;
  min-width: 0;
}

.preview-phase {
  color: var(--pm-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pm-ink-3);
}

.preview-dot.dot-running {
  background: var(--pm-success);
}

.preview-dot.dot-starting {
  background: var(--pm-warning);
}

.preview-dot.dot-failed {
  background: var(--pm-danger);
}

.preview-actions {
  gap: 6px;
}

.viewport-switch {
  border: 1px solid var(--pm-line);
  border-radius: 7px;
  overflow: hidden;
}

.viewport-switch button {
  border: 0;
  background: transparent;
  color: var(--pm-ink-3);
  padding: 4px 7px;
  font-size: 10px;
  cursor: pointer;
}

.viewport-switch button.active {
  background: var(--pm-canvas);
  color: var(--pm-ink);
}

.preview-stage {
  flex: 1;
  min-height: 0;
  padding: 14px;
  background:
    linear-gradient(90deg, rgba(232, 217, 204, 0.22) 1px, transparent 1px),
    linear-gradient(rgba(232, 217, 204, 0.22) 1px, transparent 1px), var(--pm-canvas);
  background-size: 18px 18px;
  overflow: auto;
  display: flex;
  justify-content: center;
}

.preview-card {
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: #fff;
  border-radius: 12px;
  box-shadow: var(--pm-shadow-md);
  overflow: hidden;
  transition: max-width 200ms ease;
}

.preview-card.viewport-tablet {
  max-width: 768px;
}

.preview-card.viewport-mobile {
  max-width: 390px;
}

.preview-frame {
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: 0;
  background: #fff;
}

.preview-placeholder {
  height: 100%;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px;
  text-align: center;
  background: var(--pm-page);
}

.placeholder-glyph {
  color: var(--pm-brand-soft);
  font-size: 42px;
}

.placeholder-title {
  margin: 10px 0 4px;
  color: var(--pm-ink);
  font-size: 14px;
  font-weight: 650;
}

.placeholder-desc {
  margin: 0;
  color: var(--pm-ink-3);
  font-size: 12px;
}

.placeholder-error {
  max-width: 100%;
  max-height: 180px;
  overflow: auto;
  padding: 10px;
  border-radius: 8px;
  background: var(--pm-danger-bg);
  color: var(--pm-danger);
  font: 11px/1.5 var(--pm-mono);
  text-align: left;
  white-space: pre-wrap;
}

.mobile-tabs {
  display: flex;
  padding: 0 14px;
  border-bottom: 1px solid var(--pm-line);
  background: var(--pm-page);
}

.mobile-tab {
  position: relative;
  flex: 1;
  border: 0;
  background: transparent;
  padding: 10px 8px;
  color: var(--pm-ink-3);
  font-size: 13px;
  cursor: pointer;
}

.mobile-tab.active {
  color: var(--pm-ink);
  font-weight: 650;
}

.mobile-tab.active::after {
  content: '';
  position: absolute;
  left: 30%;
  right: 30%;
  bottom: 0;
  height: 2px;
  border-radius: 999px;
  background: var(--pm-brand-strong);
}

.tab-live-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 5px;
  border-radius: 50%;
  background: var(--pm-success);
  vertical-align: middle;
}

.drawer-tip {
  color: var(--pm-ink-3);
  font-size: 13px;
  padding: 12px 0;
}

.change-list {
  display: grid;
  gap: 4px;
}

.change-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 8px;
  border: 0;
  border-bottom: 1px solid var(--pm-line);
  background: transparent;
  color: var(--pm-ink);
  text-align: left;
  cursor: pointer;
}

.change-row:hover {
  background: var(--pm-canvas);
}

.change-status {
  flex: 0 0 34px;
  font-size: 10px;
  color: var(--pm-ink-3);
}

.change-status.added {
  color: var(--pm-success);
}

.change-status.deleted {
  color: var(--pm-danger);
}

.change-status.modified {
  color: var(--pm-warning);
}

.change-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 12px var(--pm-mono);
}

.change-stats {
  display: flex;
  gap: 6px;
  color: var(--pm-ink-3);
  font-size: 10px;
}

.add {
  color: var(--pm-success);
}

.del {
  color: var(--pm-danger);
}

.diff-view,
.log-view {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: var(--pm-dark);
  color: #e9e1d8;
  font: 12px/1.6 var(--pm-mono);
  overflow: auto;
  max-height: calc(100vh - 160px);
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line {
  display: block;
  padding: 0 4px;
}

.diff-line.add {
  background: rgba(79, 115, 85, 0.28);
  color: #cfe6d2;
}

.diff-line.del {
  background: rgba(142, 63, 53, 0.3);
  color: #f0c8c1;
}

.diff-line.hunk {
  color: #f0c766;
}

.auth-frame {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  border: 0;
}

@media (max-width: 1023px) {
  .workspace-body {
    padding: 10px;
  }

  .chat-pane,
  .preview-pane {
    width: 100%;
    flex: 1;
  }

  .splitter {
    display: none;
  }
}

@media (max-width: 720px) {
  .workspace-bar {
    height: auto;
    min-height: 58px;
    padding: 8px 10px;
    flex-wrap: wrap;
  }

  .bar-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .app-heading h1 {
    max-width: 56vw;
  }

  .preview-toolbar {
    flex-wrap: wrap;
    height: auto;
    padding: 8px 10px;
    gap: 6px;
  }

  .preview-stage {
    padding: 8px;
  }
}
</style>
