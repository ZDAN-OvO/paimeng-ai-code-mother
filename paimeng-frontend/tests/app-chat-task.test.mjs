import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, reactive } from 'vue'

const require = createRequire(import.meta.url)
const file = new URL('../src/pages/app/AppChatPage.vue', import.meta.url)
const script = compileScript(parse(readFileSync(file, 'utf8')).descriptor, { id: 'app-chat-task' })
const transpile = (source) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const pageCode = transpile(script.content)
const readApi = (filename) =>
  transpile(readFileSync(new URL(`../src/api/${filename}`, import.meta.url), 'utf8'))
const taskApiCode = readApi('appTaskController.ts')
const historyApiCode = readApi('chatHistoryController.ts')
const editorCode = transpile(
  readFileSync(new URL('../src/utils/visualEditor.ts', import.meta.url), 'utf8'),
)

const appId = '1900000000000000059'
const time = '2026-11-25T21:32:01'
const preview = `http://test/api/static/html_${appId}/`
const initialPrompt = '生成一张预约页面'
const row = (id, messageType, message) => ({
  id: String(id),
  appId,
  userId: '456',
  createTime: time,
  messageType,
  message,
})
const oldHistory = [row(2, 'ai', '旧预览已交付'), row(1, 'user', '创建网站')]
const active = (taskId, status = 'running') => ({
  taskId,
  appId,
  status,
  resultCommitted: ['succeeded', 'failed'].includes(status),
  streamAvailable: status === 'running',
})
const response = (data) => ({ data: { code: 0, data } })
const flush = () => new Promise((resolve) => setImmediate(resolve))

function evaluate(code, imports, globals = {}) {
  const exports = {}
  const load = (id) => (Object.hasOwn(imports, id) ? imports[id] : require(id))
  new Function('require', 'exports', ...Object.keys(globals), code)(
    load,
    exports,
    ...Object.values(globals),
  )
  return exports
}

// 运行实际的聊天组件状态和 API 包装，替换页面外壳、网络请求和 EventSource。
function mountChat(t, server) {
  const streams = []
  const notices = []
  const timers = new Map()
  const route = reactive({ params: { id: appId } })
  const requests = []
  const request = async (url, config = {}) => {
    requests.push({ url, ...config })
    if (url === '/app/chat/tasks/active') return response(await server.active(config.params.appId))
    if (url === '/app/chat/tasks') return response(await server.submit(config.data))
    if (url.startsWith('/chatHistory/app/')) {
      return response({ records: await server.history(config.params, url.split('/').at(-1)) })
    }
    throw new Error(`未模拟的请求 ${url}`)
  }
  request.get = (url, config) => request(url, { ...config, method: 'GET' })
  request.post = (url, data, config) => request(url, { ...config, method: 'POST', data })
  request.defaults = { baseURL: 'http://test/api/' }
  const env = {
    API_BASE_URL: request.defaults.baseURL,
    getStaticPreviewUrl: (type, id) => `http://test/api/static/${type}_${id}/`,
  }
  const taskApi = evaluate(taskApiCode, { '@/request': { default: request }, '@/config/env': env })
  const historyApi = evaluate(historyApiCode, { '@/request': { default: request } })

  class FakeEventSource extends EventTarget {
    static CONNECTING = 0
    static CLOSED = 2
    readyState = 1

    constructor(url, { withCredentials }) {
      super()
      this.url = new URL(url)
      assert.equal(withCredentials, true)
      streams.push(this)
    }

    close() {
      this.readyState = FakeEventSource.CLOSED
    }

    emit(type, lastEventId, payload) {
      this.dispatchEvent(new MessageEvent(type, { lastEventId, data: JSON.stringify(payload) }))
    }

    disconnect(state) {
      this.readyState = state
      this.onerror()
    }
  }

  const component = evaluate(
    pageCode,
    {
      'vue-router': { useRoute: () => route, useRouter: () => ({ push() {} }) },
      'ant-design-vue': {
        message: {
          info: (text) => notices.push({ type: 'info', text }),
          warning: (text) => notices.push({ type: 'warning', text }),
          error: (text) => notices.push({ type: 'error', text }),
        },
      },
      '@/stores/loginUser': { useLoginUserStore: () => ({ loginUser: { id: 456 } }) },
      '@/api/appController': {
        getAppVoById: async ({ id }) => response({ id, userId: '456', initPrompt: initialPrompt }),
      },
      '@/api/chatHistoryController': historyApi,
      '@/api/appTaskController': taskApi,
      '@/request': { default: request },
      '@/components/MarkdownRenderer.vue': {},
      '@/components/AppDetailModal.vue': {},
      '@/components/DeploySuccessModal.vue': {},
      '@/assets/aiAvatar.png': {},
      '@/config/env': env,
      '@/utils/codeGenTypes': { CodeGenTypeEnum: { HTML: 'html' } },
      '@/utils/visualEditor': evaluate(
        editorCode,
        {},
        { window: { location: { href: 'http://chat.test/' } } },
      ),
      '@ant-design/icons-vue': {},
    },
    {
      EventSource: FakeEventSource,
      window: { addEventListener() {}, removeEventListener() {} },
      setTimeout: (callback) => {
        const id = Symbol()
        timers.set(id, callback)
        return id
      },
      clearTimeout: (id) => timers.delete(id),
    },
  ).default
  component.render = () => null
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {} })
  const app = renderer.createApp(component)
  const state = app.mount({}).$.setupState
  let mounted = true
  const unmount = () => {
    if (mounted) app.unmount()
    mounted = false
  }
  t.after(unmount)
  return {
    route,
    state,
    streams,
    requests,
    notices,
    unmount,
    runTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id)
        callback()
      }
    },
    text: () => state.messages.map((entry) => entry.content),
  }
}

test('两个标签页同时首次打开，使用稳定请求 ID 并回放同一任务', async (t) => {
  const taskId = 'first'
  let submissions = 0
  let records = []
  const server = {
    active: () => null,
    history: () => records,
    submit: (data) => {
      assert.deepEqual(data, { appId, message: initialPrompt, clientRequestId: `init:${appId}` })
      return { taskId, conflict: false, reused: submissions++ === 1 }
    },
  }
  const a = mountChat(t, server)
  const b = mountChat(t, server)
  b.state.userInput = '用户正在输入的草稿'
  await flush()
  const startUrls = [
    '/app/chat/tasks/active',
    `/chatHistory/app/${appId}`,
    '/app/chat/tasks/active',
    '/app/chat/tasks',
  ]
  assert.deepEqual(
    a.requests.map(({ url }) => url),
    startUrls,
  )
  assert.deepEqual(
    b.requests.map(({ url }) => url),
    startUrls,
  )
  assert.equal(b.state.userInput, '用户正在输入的草稿')
  assert.deepEqual(a.text(), [initialPrompt, ''])
  assert.deepEqual(b.text(), [''])

  records = [row(31, 'user', initialPrompt)]
  for (const tab of [a, b]) {
    assert.equal(tab.streams[0].url.pathname, '/api/app/chat/tasks/first/events')
    tab.streams[0].emit('message', '30-0', { taskId, d: '预约' })
  }
  await flush()
  assert.deepEqual(a.text(), [initialPrompt, '预约'])
  assert.deepEqual(b.text(), a.text())

  records = [row(32, 'ai', '预约页面已交付'), ...records]
  for (const tab of [a, b]) {
    tab.streams[0].emit('done', '30-1', { taskId, status: 'success' })
  }
  await flush()
  for (const tab of [a, b]) {
    assert.deepEqual(tab.text(), [initialPrompt, '预约页面已交付'])
    assert.equal(tab.state.previewUrl, `${preview}?task=first`)
    assert.equal(tab.state.isChatBusy, false)
    assert.equal(tab.streams[0].readyState, 2)
  }
})

test('复查发现任务已提交时重新读历史，首发准入撞车时只刷新历史', async (t) => {
  let checks = 0
  let historyReads = 0
  const tab = mountChat(t, {
    active: () => (checks++ === 0 ? null : active('ended', 'succeeded')),
    history: () => (historyReads++ === 0 ? [] : oldHistory),
    submit: () => assert.fail('已有任务时不能自动提交'),
  })
  await flush()
  assert.equal(checks, 2)
  assert.equal(historyReads, 2)
  assert.deepEqual(tab.text(), ['创建网站', '旧预览已交付'])
  assert.equal(tab.streams.length, 0)
  assert.equal(tab.state.previewUrl, `${preview}?task=ended`)

  historyReads = 0
  const rejected = mountChat(t, {
    active: () => null,
    history: () => (historyReads++ === 0 ? [] : oldHistory),
    submit: () => ({ taskId: null, conflict: true, reused: false, code: 'HISTORY_EXISTS' }),
  })
  await flush()
  assert.equal(historyReads, 2)
  assert.deepEqual(rejected.text(), ['创建网站', '旧预览已交付'])
  assert.deepEqual(rejected.notices, [])
  assert.equal(rejected.streams.length, 0)
})

test('已有历史不会重发初始提示词，翻页原样发送同秒复合游标', async (t) => {
  const firstPage = Array.from({ length: 10 }, (_, index) =>
    row(1900000000000000010n - BigInt(index), 'ai', String(10 - index)),
  )
  const tab = mountChat(t, {
    active: () => null,
    history: (params) => (params.lastId ? [row(1900000000000000000n, 'user', '0')] : firstPage),
    submit: () => assert.fail('有旧历史时不能自动提交'),
  })
  await flush()
  assert.equal(tab.state.previewUrl, preview)
  assert.equal(tab.state.hasMoreHistory, true)
  tab.state.loadMoreHistory()
  await flush()
  assert.deepEqual(tab.requests.at(-1).params, {
    pageSize: 10,
    lastCreateTime: time,
    lastId: '1900000000000000001',
  })
  assert.deepEqual(
    tab.text(),
    Array.from({ length: 11 }, (_, index) => String(index)),
  )
  assert.equal(tab.state.hasMoreHistory, false)
})

test('并发撞车原样保留输入，重连事件去重，失败时保留旧预览和失败原因', async (t) => {
  const taskId = 'working'
  let task = null
  let records = oldHistory
  const server = {
    active: () => task,
    history: () => records,
    submit: (data) => {
      assert.match(data.clientRequestId, /^[0-9a-f-]{36}$/)
      if (task) return { taskId, conflict: true, reused: false }
      task = active(taskId)
      records = [row(3, 'user', data.message), ...records]
      return { taskId, conflict: false, reused: false }
    },
  }
  const a = mountChat(t, server)
  const b = mountChat(t, server)
  await flush()
  a.state.userInput = '修改标题'
  await a.state.sendMessage()
  b.state.userInput = '  自己的下一条草稿  '
  await b.state.sendMessage()
  assert.equal(a.state.userInput, '')
  assert.equal(b.state.userInput, '  自己的下一条草稿  ')
  assert.deepEqual(b.notices, [{ type: 'info', text: '该应用正在生成' }])
  const c = mountChat(t, server)
  await flush()
  for (const tab of [a, b, c]) {
    const source = tab.streams[0]
    source.emit('message', '31-8', { taskId, d: '构建' })
    source.disconnect(0)
    source.emit('message', '31-8', { taskId, d: '构建' })
    source.emit('message', '31-7', { taskId, d: '旧片段' })
    source.emit('message', '31-10', { taskId, d: '一次' })
    source.emit('status', '31-11', { taskId, phase: 'repairing', attempt: 2 })
    source.emit('status', '31-11', { taskId, phase: 'repairing', attempt: 2 })
  }
  await flush()
  for (const tab of [a, b, c]) {
    assert.deepEqual(tab.text(), ['创建网站', '旧预览已交付', '修改标题', '构建一次'])
    assert.deepEqual(tab.state.messages.at(-1).statuses, [
      { id: '31-11', text: '正在修复并重新构建（第 2 次）' },
    ])
    assert.equal(tab.state.previewUrl, preview)
  }

  records = [row(4, 'ai', '未生成新版本'), ...records]
  for (const tab of [a, b, c]) {
    const source = tab.streams[0]
    source.emit('business-error', '31-12', {
      taskId,
      status: 'failed',
      message: '构建修复次数已用尽',
    })
    source.emit('done', '31-13', { taskId, status: 'success' })
  }
  await flush()
  for (const tab of [a, b, c]) {
    assert.equal(tab.state.messages.at(-1).error, '构建修复次数已用尽')
    assert.equal(tab.state.previewUrl, preview)
    assert.equal(tab.state.isChatBusy, false)
    assert.equal(tab.streams[0].readyState, 2)
  }
  assert.equal(b.state.userInput, '  自己的下一条草稿  ')
})

test('手工重连发送最后的 SSE ID，过期提示回源且不保留残缺气泡', async (t) => {
  const taskId = 'recover'
  let task = active(taskId)
  let records = [row(3, 'user', '更新网站'), ...oldHistory]
  const tab = mountChat(t, { active: () => task, history: () => records })
  await flush()
  tab.streams[0].emit('message', '9007199254740993999-2', { taskId, d: '回放的前半段' })
  await flush()
  tab.streams[0].disconnect(2)
  tab.runTimers()
  await flush()
  const resumed = tab.streams[1]
  assert.equal(resumed.url.searchParams.get('lastEventId'), '9007199254740993999-2')
  resumed.emit('message', '9007199254740993999-2', { taskId, d: '重复的前半段' })
  assert.equal(tab.text().at(-1), '回放的前半段')

  records = [row(4, 'ai', '已保存的全文'), ...records]
  task = active(taskId, 'succeeded')
  resumed.emit('status', '0-0', { taskId, phase: 'resync_required' })
  await flush()
  assert.equal(resumed.readyState, 2)
  assert.equal(tab.streams.length, 2)
  assert.deepEqual(tab.text(), ['创建网站', '旧预览已交付', '更新网站', '已保存的全文'])
  assert.equal(tab.state.previewUrl, `${preview}?task=recover`)
})

test('切换应用和卸载页面会关闭旧流并忽略迟到的事件', async (t) => {
  const otherId = '1900000000000000061'
  const tab = mountChat(t, {
    active: (id) => active(id === appId ? 'original' : 'other'),
    history: (_, id) => [row(3, 'user', id)],
  })
  await flush()
  const original = tab.streams[0]
  const originalSignal = tab.requests[0].signal
  tab.route.params.id = otherId
  await flush()
  assert.equal(original.readyState, 2)
  assert.equal(originalSignal.aborted, true)
  assert.match(tab.streams[1].url.pathname, /\/other\/events$/)
  original.emit('message', '40-0', { taskId: 'original', d: '过时事件' })
  assert.deepEqual(tab.text(), [otherId, ''])
  tab.unmount()
  assert.equal(tab.streams[1].readyState, 2)
})

test('跨源预览须确认编辑已开启，退出或导航后忽略迟到的点选消息', () => {
  const selected = []
  const states = []
  const sent = []
  const origin = new URL(preview).origin
  const contentWindow = {
    postMessage: (data, targetOrigin) => sent.push({ ...data, targetOrigin }),
  }
  const iframe = {
    src: preview + '?task=delivered',
    contentWindow,
    get contentDocument() {
      return null
    },
  }
  const { VisualEditor } = evaluate(
    editorCode,
    {},
    {
      window: { location: { href: 'http://chat.test/app/chat/' + appId } },
    },
  )
  const editor = new VisualEditor({
    onElementSelected: (element) => selected.push(element),
    onEditStateChange: (state) => states.push(state),
  })
  const receive = (type, data = {}, overrides = {}) =>
    editor.handleIframeMessage({
      source: contentWindow,
      origin,
      data: { channel: 'paimeng-visual-editor', connectionId: sent[0].connectionId, type, ...data },
      ...overrides,
    })
  const element = {
    tagName: 'path',
    id: '',
    className: 'icon',
    textContent: '',
    selector: 'svg > path.icon',
  }

  editor.onIframeLoad(iframe)
  assert.equal(sent[0].type, 'connect')
  assert.equal(sent[0].targetOrigin, origin)
  assert.equal(editor.toggleEditMode(), false)
  receive('ready', { pageUrl: iframe.src }, { source: {} })
  receive('ready', { pageUrl: iframe.src }, { origin: 'http://unrelated.test' })
  receive('ready', { pageUrl: 'http://test/api/other/' })
  assert.equal(editor.toggleEditMode(), false)
  receive('ready', { pageUrl: iframe.src })
  assert.equal(editor.toggleEditMode(), true)
  const first = sent.at(-1).editId
  assert.deepEqual(states, ['starting'])
  editor.disableEditMode()
  receive('editing', { editId: first, pageUrl: iframe.src })
  assert.deepEqual(states, ['starting', 'idle'])

  assert.equal(editor.toggleEditMode(), true)
  const editId = sent.at(-1).editId
  assert.notEqual(editId, first)
  receive('editing', { editId, pageUrl: iframe.src })
  assert.equal(states.at(-1), 'editing')
  receive('selected', { editId, element, pageUrl: 'http://test/api/other/' })
  receive('selected', { editId, element: { ...element, selector: [] }, pageUrl: iframe.src })
  assert.deepEqual(selected, [])
  receive('selected', {
    editId,
    element,
    pageUrl: iframe.src + '&filter=open%20now&task=business#/items?task=15',
  })
  receive('selected', { editId, element, pageUrl: preview + 'about.html?task=business#team' })
  assert.deepEqual(
    selected.map(({ pagePath, selector }) => [pagePath, selector]),
    [
      ['?filter=open%20now&task=business#/items?task=15', 'svg > path.icon'],
      ['about.html?task=business#team', 'svg > path.icon'],
    ],
  )

  editor.onIframeLoad(iframe)
  receive('selected', { editId, element, pageUrl: iframe.src })
  assert.equal(selected.length, 2)
  assert.equal(states.at(-1), 'idle')
  editor.disconnect()
})

test('预览脚本点选 SVG 后，聊天提交选择器并在任务交付后更新预览', async (t) => {
  const taskId = 'svg-update'
  let records = oldHistory
  const tab = mountChat(t, {
    active: () => null,
    history: () => records,
    submit: ({ message }) => {
      assert.equal(
        message,
        '换成蓝色\n\n选中元素信息：\n- 页面路径: #/icons?size=large\n- 标签: path' +
          '\n- 选择器: svg#badge > path.glyph:nth-child(1)',
      )
      records = [row(3, 'user', message), ...records]
      return { taskId, conflict: false, reused: false }
    },
  })
  await flush()

  const pageUrl = new URL(tab.state.previewUrl)
  pageUrl.hash = '/icons?size=large'
  const chatOrigin = 'http://chat.test'
  const listeners = new Map()
  const toFrame = []
  const contentWindow = {
    postMessage(data, origin) {
      assert.equal(origin, pageUrl.origin)
      toFrame.push(data)
    },
  }
  const parent = {
    postMessage(data, origin) {
      assert.equal(origin, chatOrigin)
      tab.state.onPreviewMessage({ source: contentWindow, origin: pageUrl.origin, data })
    },
  }
  const browser = {
    parent,
    location: pageUrl,
    history: {
      pushState(_state, _unused, url) {
        pageUrl.href = new URL(url, pageUrl).href
      },
      replaceState(_state, _unused, url) {
        pageUrl.href = new URL(url, pageUrl).href
      },
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  const deliver = () => {
    for (const data of toFrame.splice(0)) {
      listeners.get('message')({ source: parent, origin: chatOrigin, data })
    }
  }

  class FakeElement {
    id = ''
    classList = []
    attributes = new Map()
    children = []
    style = {}
    constructor(localName) {
      this.tagName = localName
      this.localName = localName
    }
    appendChild(child) {
      this.children.push(child)
      child.parentElement = this
    }
    setAttribute(name, value) {
      this.attributes.set(name, value)
    }
    removeAttribute(name) {
      this.attributes.delete(name)
    }
    remove() {}
  }
  const doc = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    createElement: (name) => new FakeElement(name),
  }
  const svg = new FakeElement('svg')
  svg.id = 'badge'
  doc.body.appendChild(svg)
  const path = new FakeElement('path')
  path.classList = ['glyph']
  path.className = { baseVal: 'glyph' }
  svg.appendChild(path)
  const bridge = readFileSync(
    new URL('../../paimeng-backend/src/main/resources/preview/visual-editor.js', import.meta.url),
    'utf8',
  )
  const runBridge = new Function(
    'window',
    'document',
    'Element',
    'CSS',
    'setTimeout',
    'clearTimeout',
    bridge,
  )
  runBridge(
    browser,
    doc,
    FakeElement,
    { escape: (name) => name },
    () => 1,
    () => {},
  )

  const iframe = { src: tab.state.previewUrl, contentWindow }
  tab.state.previewFrame = iframe
  tab.state.onIframeLoad({ currentTarget: iframe })
  deliver()
  assert.equal(listeners.has('click'), false)
  tab.state.toggleEditMode()
  assert.equal(tab.state.isEditMode, false)
  deliver()
  assert.equal(tab.state.isEditMode, true)

  const selectPath = () => {
    let prevented = false
    listeners.get('click')({
      target: path,
      preventDefault: () => {
        prevented = true
      },
      stopImmediatePropagation() {},
    })
    assert.equal(prevented, true)
    assert.equal(tab.state.selectedElementInfo.className, 'glyph')
    assert.equal(path.attributes.has('data-paimeng-visual-selected'), true)
  }
  selectPath()
  browser.history.pushState({}, '', '#/other')
  assert.equal(tab.state.selectedElementInfo, null)
  assert.equal(path.attributes.has('data-paimeng-visual-selected'), false)
  selectPath()
  assert.equal(tab.state.selectedElementInfo.pagePath, '#/other')
  browser.history.replaceState({}, '', '#/icons?size=large')
  assert.equal(tab.state.selectedElementInfo, null)
  assert.equal(path.attributes.has('data-paimeng-visual-selected'), false)
  selectPath()

  tab.state.toggleEditMode()
  deliver()
  assert.equal(listeners.has('click'), false)
  assert.equal(path.attributes.has('data-paimeng-visual-selected'), false)
  assert.equal(tab.state.selectedElementInfo, null)

  tab.state.toggleEditMode()
  deliver()
  selectPath()
  tab.state.userInput = '换成蓝色'
  await tab.state.sendMessage()
  deliver()
  assert.equal(tab.state.isEditMode, false)
  assert.equal(listeners.has('click'), false)

  records = [row(4, 'ai', '已更新 SVG'), ...records]
  tab.streams[0].emit('done', '50-1', { taskId, status: 'success' })
  await flush()
  assert.equal(tab.state.previewUrl, preview + '?task=' + taskId)
})
