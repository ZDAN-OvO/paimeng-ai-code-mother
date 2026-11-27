export interface ElementInfo {
  tagName: string
  id: string
  className: string
  textContent: string
  selector: string
  pagePath: string
}

type EditState = 'idle' | 'starting' | 'editing'

interface VisualEditorOptions {
  onElementSelected?: (elementInfo: ElementInfo) => void
  onSelectionCleared?: () => void
  onEditStateChange?: (state: EditState) => void
  onEditTimeout?: () => void
}

const CHANNEL = 'paimeng-visual-editor'

function selectedElement(value: unknown): Omit<ElementInfo, 'pagePath'> | undefined {
  if (!value || typeof value !== 'object') return
  const { tagName, id, className, textContent, selector } = value as Record<string, unknown>
  if (
    typeof tagName === 'string' &&
    /^[a-z][\w:-]*$/i.test(tagName) &&
    typeof id === 'string' &&
    typeof className === 'string' &&
    typeof textContent === 'string' &&
    textContent.length <= 100 &&
    typeof selector === 'string' &&
    selector
  ) {
    return { tagName, id, className, textContent, selector }
  }
}

export class VisualEditor {
  private preview?: { target: Window; initialUrl: URL; baseUrl: URL }
  private connectionId = ''
  private ready = false
  private state: EditState = 'idle'
  private editId = 0
  private editTimeout?: ReturnType<typeof setTimeout>

  constructor(private readonly options: VisualEditorOptions = {}) {}

  onIframeLoad(iframe: HTMLIFrameElement) {
    this.disconnect()
    if (!iframe.contentWindow) return
    const initialUrl = new URL(iframe.src, window.location.href)
    this.preview = { target: iframe.contentWindow, initialUrl, baseUrl: new URL('.', initialUrl) }
    this.connect()
  }

  disconnect() {
    this.disableEditMode()
    this.ready = false
    this.preview = undefined
    this.connectionId = ''
  }

  toggleEditMode() {
    if (this.state !== 'idle') {
      this.disableEditMode()
      return true
    }
    if (!this.ready) return false

    const editId = ++this.editId
    this.setState('starting')
    this.post('set-edit-mode', { enabled: true, editId })
    this.editTimeout = setTimeout(() => {
      this.disableEditMode()
      this.options.onEditTimeout?.()
    }, 3000)
    return true
  }

  disableEditMode() {
    if (this.state === 'idle') return
    this.post('set-edit-mode', { enabled: false, editId: this.editId })
    this.setState('idle')
  }

  clearSelection() {
    if (this.state === 'editing') this.post('clear-selection', { editId: this.editId })
  }

  handleIframeMessage(event: MessageEvent) {
    if (
      !this.preview ||
      event.source !== this.preview.target ||
      event.origin !== this.preview.initialUrl.origin
    ) {
      return
    }
    const data = event.data
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return
    const pagePath = this.getPagePath(data.pageUrl)
    if (pagePath === undefined) return

    // 从浏览器缓存返回预览页时，iframe 可能不再触发 load。
    if (data.type === 'restored') {
      this.connect()
      return
    }
    if (!this.connectionId || data.connectionId !== this.connectionId) return
    if (data.type === 'ready') {
      this.ready = true
      return
    }
    if (data.type === 'leaving') {
      this.connectionId = ''
      this.ready = false
      this.setState('idle')
      return
    }
    if (data.editId !== this.editId) return
    if (data.type === 'editing' && this.state === 'starting') {
      this.setState('editing')
    } else if (this.state === 'editing') {
      if (data.type === 'selected') {
        const element = selectedElement(data.element)
        if (element) this.options.onElementSelected?.({ ...element, pagePath })
      } else if (data.type === 'selection-cleared') {
        this.options.onSelectionCleared?.()
      }
    }
  }

  private connect() {
    this.ready = false
    this.setState('idle')
    this.connectionId = crypto.getRandomValues(new Uint32Array(4)).join('-')
    this.post('connect')
  }

  private setState(state: EditState) {
    clearTimeout(this.editTimeout)
    this.editTimeout = undefined
    if (this.state === state) return
    this.state = state
    this.options.onEditStateChange?.(state)
  }

  private post(type: string, data: { editId?: number; enabled?: boolean } = {}) {
    this.preview?.target.postMessage(
      { ...data, channel: CHANNEL, type, connectionId: this.connectionId },
      this.preview.initialUrl.origin,
    )
  }

  private getPagePath(value: unknown): string | undefined {
    if (!this.preview || typeof value !== 'string') return
    const { initialUrl, baseUrl } = this.preview
    let page: URL
    try {
      page = new URL(value)
    } catch {
      return
    }
    if (page.origin !== initialUrl.origin || !page.pathname.startsWith(baseUrl.pathname)) return

    let search = page.search
    const taskId = initialUrl.searchParams.get('task')
    if (taskId !== null && page.pathname === initialUrl.pathname) {
      // 仅移除任务交付时追加的参数，保留站点参数的顺序和编码。
      const parameters = search.slice(1).split('&')
      const internal = parameters.findIndex(
        (part) => new URLSearchParams('?' + part).get('task') === taskId,
      )
      if (internal !== -1) {
        parameters.splice(internal, 1)
        search = parameters.length ? '?' + parameters.join('&') : ''
      }
    }
    const file = page.pathname.slice(baseUrl.pathname.length)
    return (file === 'index.html' ? '' : file) + search + page.hash
  }
}
