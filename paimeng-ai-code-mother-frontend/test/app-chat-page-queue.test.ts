import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mergeHistoryWithLiveMessages } from '../src/utils/chatStream.ts'
import * as Vue from 'vue'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import {
  draftAfterReturnedRemoval,
  isUnknownEnqueueOutcome,
  queueItemLabel,
  returnedItemDraft,
} from '../src/utils/queuedChatCoordinator.ts'
import type { QueueItem } from '../src/api/chatTypes.ts'
import { queuedItem } from './support/queue.ts'

const pageSource = readFileSync(
  new URL('../src/pages/app/AppChatPage.vue', import.meta.url),
  'utf8',
)
const pageDescriptor = parse(pageSource).descriptor

const pageAction = (name: string, bindings: Record<string, unknown>, property?: string) => {
  const script = ts.createSourceFile(
    'AppChatPage.ts',
    pageDescriptor.scriptSetup!.content,
    ts.ScriptTarget.Latest,
    true,
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(script) === name) {
      initializer = node.initializer
      if (property && initializer && ts.isCallExpression(initializer)) {
        const dependencies = initializer.arguments[0]
        assert.ok(dependencies && ts.isObjectLiteralExpression(dependencies))
        const entry = dependencies.properties.find(
          (entry) => entry.name?.getText(script) === property,
        )
        assert.ok(entry && ts.isPropertyAssignment(entry))
        initializer = entry.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(script)
  assert.ok(initializer, `missing page action ${name}`)
  const compiled = ts.transpileModule(`const action = ${initializer.getText(script)}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText
  return new Function(...Object.keys(bindings), `${compiled}; return action`)(
    ...Object.values(bindings),
  )
}

test('returned items expose independent delete and restore actions without overwriting drafts', async () => {
  const template = pageDescriptor.template!
  const start = template.content.indexOf('<div v-for="item in queueItems"')
  const end = template.content.indexOf('\n          </div>', start)
  assert.ok(start >= 0 && end > start)
  const compiled = compileTemplate({
    source: template.content.slice(start, end),
    filename: 'AppChatPage.vue',
    id: 'queue-actions',
  })
  assert.deepEqual(compiled.errors, [])
  const render = new Function(
    'Vue',
    compiled.code
      .replace(
        /import \{([^}]+)\} from "vue"/,
        (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue`,
      )
      .replace('export function render', 'return function render'),
  )({ ...Vue, resolveComponent: (name: string) => name })
  const item = queuedItem({ status: 'returned' })
  const inputMessage = { value: '未发送的新草稿' }
  const localReturnedRestores = { value: [item] }
  const queueActionBusy = { value: false }
  const removed: string[] = []
  const removeQueueItem = pageAction('removeQueueItem', {
    queueActionBusy,
    localReturnedRestores,
    queueState: { value: { items: [item] } },
    queuedChatCoordinator: { remove: async (id: string) => removed.push(id) },
    message: { error: () => assert.fail('removal should succeed') },
  })
  const restoreQueueItem = pageAction('restoreQueueItem', {
    inputMessage,
    returnedItemDraft,
    hasDraftContent: { value: true },
    message: { info: () => undefined },
  })
  const tree = render(
    {
      queueItems: [item],
      queueItemLabel,
      hasDraftContent: true,
      queueActionBusy: false,
      removeQueueItem,
      restoreQueueItem,
    },
    [],
  )
  const nodes: Vue.VNode[] = []
  const collect = (node: Vue.VNode) => {
    nodes.push(node)
    if (Array.isArray(node.children))
      node.children.forEach((child) => {
        if (typeof child === 'object' && child) collect(child as Vue.VNode)
      })
  }
  collect(tree)
  const restore = nodes.find((node) => node.props?.['aria-label'] === '恢复为草稿')
  const remove = nodes.find((node) => node.props?.['aria-label'] === '移出队列')
  assert.ok(restore)
  assert.ok(remove, 'returned item must have a direct delete button')
  assert.equal(restore.props!.disabled, true)
  assert.equal(remove.props!.disabled, false)
  assert.equal(await restoreQueueItem(item), false)
  await remove.props!.onClick()
  assert.deepEqual(removed, [item.id])
  assert.deepEqual(localReturnedRestores.value, [])
  assert.equal(inputMessage.value, '未发送的新草稿')
})

test('recovering an older terminal run cannot change the active run indicator', () => {
  const runStatus = { value: 'running' }
  const terminalRunStatuses = new Map<string, string>()
  const item = { status: 'streaming', modelProgress: '处理中', errorSummary: null }
  let historyLoads = 0
  const handleEvent = pageAction('handleEvent', {
    liveRunIds: new Set<string>(),
    runStatus,
    runId: { value: 'run-current' },
    terminalRunStatuses,
    queueState: { value: { activeRun: { runId: 'run-current', status: 'running' } } },
    ensureAssistantItem: () => item,
    loadDetails: () => undefined,
    loadHistory: () => {
      historyLoads += 1
    },
    syncPreview: () => undefined,
  })
  handleEvent({
    runId: 'run-old',
    type: 'run-finished',
    payload: { status: 'failed', errorSummary: '旧轮次失败' },
  })
  assert.equal(runStatus.value, 'running')
  assert.equal(item.status, 'failed')
  assert.equal(terminalRunStatuses.get('run-old'), 'failed')
  assert.equal(historyLoads, 1)
})

test('an older terminal result cannot replace a newer failed result after the queue becomes idle', () => {
  const runStatus = { value: 'failed' }
  const runId = { value: 'run-newer' }
  const item = { status: 'streaming', modelProgress: '', errorSummary: null }
  const terminalRunStatuses = new Map([['run-newer', 'failed']])
  const handleEvent = pageAction('handleEvent', {
    liveRunIds: new Set<string>(),
    runStatus,
    runId,
    terminalRunStatuses,
    queueState: { value: { activeRun: null } },
    ensureAssistantItem: () => item,
    loadDetails: () => undefined,
    loadHistory: () => undefined,
    syncPreview: () => undefined,
  })
  handleEvent({ runId: 'run-old', type: 'run-finished', payload: { status: 'completed' } })
  assert.equal(runStatus.value, 'failed')
  assert.equal(runId.value, 'run-newer')
  assert.equal(item.status, 'completed')
})

test('fresh idle history owns the latest run but a response requested before a new run cannot replace it', async () => {
  const runId = { value: 'run-old' }
  const runStatus = { value: 'completed' }
  let resolveHistory!: (result: unknown) => void
  const pending = new Promise((resolve) => {
    resolveHistory = resolve
  })
  const record = {
    role: 'assistant',
    runId: 'run-missed',
    status: 'failed',
    id: 12,
    message: { id: 'assistant:run-missed', role: 'assistant', parts: [] },
  }
  let response: Promise<unknown> = Promise.resolve({
    data: { code: 0, data: { records: [record], hasMore: false } },
  })
  const loadHistory = pageAction('loadHistory', {
    liveRunIds: new Set<string>(),
    mergeHistoryWithLiveMessages,
    runId,
    runStatus,
    disposed: false,
    appId: 7,
    historyLoading: { value: false },
    historyQueue: { run: (work: () => unknown) => work() },
    listAppChatHistory: () => response,
    toChatItem: (item: unknown) => item,
    messages: { value: [] },
    nextCursor: { value: null },
    hasMore: { value: false },
    scrollPinned: { value: false },
    scrollToBottom: () => undefined,
    queueState: { value: { activeRun: null } },
    terminalRunStatuses: new Map<string, string>(),
    loadDetails: () => undefined,
    message: { error: () => assert.fail('history must load successfully') },
  })
  await loadHistory(true)
  assert.equal(runId.value, 'run-missed')
  assert.equal(runStatus.value, 'failed')
  response = pending
  const loading = loadHistory(true)
  runId.value = 'run-latest'
  runStatus.value = 'completed'
  resolveHistory({ data: { code: 0, data: { records: [record], hasMore: false } } })
  await loading
  assert.equal(runId.value, 'run-latest')
  assert.equal(runStatus.value, 'completed')
})

test('enqueue business errors keep their envelope and run lookup passes both request selectors', async () => {
  const response = { status: 200, data: { code: 50000, message: '依赖异常', data: null } }
  const enqueue = pageAction(
    'queuedChatCoordinator',
    { enqueueMessage: async () => response },
    'enqueue',
  )
  await assert.rejects(enqueue({}), (error) => {
    assert.equal((error as { response: unknown }).response, response)
    return isUnknownEnqueueOutcome(error)
  })
  const selectors: unknown[] = []
  const findRun = pageAction(
    'queuedChatCoordinator',
    {
      getRunStatus: async (params: unknown) => {
        selectors.push(params)
        return {
          data: { code: 0, data: { runId: 'actual-run', status: 'completed', errorSummary: null } },
        }
      },
    },
    'findRunByRequest',
  )
  assert.deepEqual(await findRun(7, 'request-1'), {
    runId: 'actual-run',
    status: 'completed',
    errorSummary: null,
  })
  assert.deepEqual(selectors, [{ appId: 7, clientRequestId: 'request-1' }])
})

test('editing during restoration retains the returned message and local deletion leaves the new draft intact', async () => {
  const item = queuedItem({ status: 'returned' })
  const inputMessage = { value: '' }
  const queueState = { value: { items: [item] } }
  const localReturnedRestores = { value: [] as QueueItem[] }
  const queueActionBusy = { value: false }
  let removals = 0
  const removeQueueItem = pageAction('removeQueueItem', {
    queueActionBusy,
    queueState,
    localReturnedRestores,
    queuedChatCoordinator: {
      remove: async () => {
        removals += 1
        queueState.value.items = []
        inputMessage.value = '恢复期间输入的新草稿'
      },
    },
  })
  const restoreQueueItem = pageAction('restoreQueueItem', {
    inputMessage,
    localReturnedRestores,
    returnedItemDraft,
    draftAfterReturnedRemoval,
    draftRevision: 0,
    removeQueueItem,
    message: { info: () => undefined },
  })
  assert.equal(await restoreQueueItem(item), true)
  assert.equal(inputMessage.value, '恢复期间输入的新草稿')
  assert.deepEqual(localReturnedRestores.value, [item])
  assert.equal(await removeQueueItem(item), true)
  assert.equal(removals, 1, 'local restore must not require a second server removal')
  assert.deepEqual(localReturnedRestores.value, [])
  assert.equal(inputMessage.value, '恢复期间输入的新草稿')
})

test('a running preview status during generation attaches the preview without waiting for the run to finish', async () => {
  const previewStatus = { value: 'stopped' }
  let attached = 0
  const handleEvent = pageAction('handleEvent', {
    previewSyncSeq: 0,
    previewStatus,
    previewError: { value: '' },
    attachPreview: async () => {
      attached += 1
    },
  })
  handleEvent({ type: 'preview-status', runId: 'run-1', payload: { status: 'running' } })
  assert.equal(previewStatus.value, 'running')
  assert.equal(attached, 1, 'preview must be shown as soon as it is running')
})

test('opening the page while a run is active still attaches an already running preview', async () => {
  const runId = { value: null as string | null }
  const runStatus = { value: 'idle' }
  let attached = 0
  const loadApp = pageAction('loadApp', {
    appId: 7,
    getAppVoById: async () => ({
      data: {
        code: 0,
        data: {
          preview: { status: 'running', lastError: null },
          currentRun: { runId: 'run-1', status: 'running' },
        },
      },
    }),
    app: { value: null },
    previewStatus: { value: 'stopped' },
    previewError: { value: '' },
    runId,
    runStatus,
    currentRunFallback: null,
    attachPreview: async () => {
      attached += 1
    },
    message: { error: (text: string) => assert.fail(text) },
    router: { push: async () => assert.fail('should stay on page') },
  })
  await loadApp()
  assert.equal(runStatus.value, 'running')
  assert.equal(attached, 1)
})

test('a finished file write probes the preview once so static pages appear before validation', () => {
  let synced = 0
  const syncPreviewAfterFileChange = pageAction('syncPreviewAfterFileChange', {
    previewSrc: { value: '' },
    previewProbedToolCalls: new Set<string>(),
    syncPreview: async () => {
      synced += 1
    },
  })
  const message = (state: string) => ({
    id: 'm',
    role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'write', toolCallId: 'call-1', state }],
  })
  syncPreviewAfterFileChange('run-1', message('input-available'))
  assert.equal(synced, 0)
  syncPreviewAfterFileChange('run-1', message('output-available'))
  syncPreviewAfterFileChange('run-1', message('output-available'))
  assert.equal(synced, 1)
  syncPreviewAfterFileChange('run-2', message('output-available'))
  assert.equal(synced, 2, 'a reused tool call id in a later run still probes')
})

test('concurrent preview attaches share one access request', async () => {
  let requests = 0
  let release = () => {}
  const previewSrc = { value: '' }
  const attachPreview = pageAction('attachPreview', {
    previewSrc,
    previewAttach: null,
    applyPreviewAccess: () => {
      requests += 1
      return new Promise<void>((resolve) => {
        release = () => {
          previewSrc.value = 'http://preview/'
          resolve()
        }
      })
    },
  })
  const first = attachPreview()
  const second = attachPreview()
  release()
  await Promise.all([first, second])
  await attachPreview()
  assert.equal(requests, 1)
})

test('a stale preview probe cannot overwrite a newer result', async () => {
  const responses: Array<(status: string) => void> = []
  const previewStatus = { value: 'stopped' }
  let attached = 0
  const syncPreview = pageAction('syncPreview', {
    appId: 7,
    disposed: false,
    previewSyncSeq: 0,
    getPreviewStatus: () =>
      new Promise((resolve) =>
        responses.push((status) => resolve({ data: { code: 0, data: { status, lastError: null } } })),
      ),
    previewStatus,
    previewError: { value: '' },
    attachPreview: async () => {
      attached += 1
    },
    schedulePreviewPoll: () => assert.fail('stale starting must not schedule polling'),
  })
  const older = syncPreview()
  const newer = syncPreview()
  responses[1]('running')
  await newer
  responses[0]('starting')
  await older
  assert.equal(previewStatus.value, 'running')
  assert.equal(attached, 1)
})

test('preview polling and heartbeat stop once the page is unmounted', async () => {
  const schedulePreviewPoll = pageAction('schedulePreviewPoll', {
    disposed: true,
    previewTimer: null,
    window: { setTimeout: () => assert.fail('no poll after unmount') },
  })
  schedulePreviewPoll()
  const requestAndSubmitTicket = pageAction('requestAndSubmitTicket', {
    appId: 7,
    disposed: true,
    requestPreviewAccess: async () => ({
      data: { code: 0, data: { url: 'http://preview', ticket: { ticket: 't' } } },
    }),
    previewUrl: { value: '' },
    submitPreviewTicket: async () => undefined,
    lastAccessAt: { value: 0 },
    startHeartbeat: () => assert.fail('no heartbeat after unmount'),
  })
  await requestAndSubmitTicket()
})
