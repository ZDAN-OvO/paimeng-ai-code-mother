import type { AppUIMessageChunk } from '../conversations/ui-message'

type Listener = (chunk: AppUIMessageChunk | null) => void

export class RunStream {
  private readonly chunks: AppUIMessageChunk[] = []
  private readonly listeners = new Set<Listener>()
  private closed = false

  constructor(readonly runId: string) {}

  emit(chunk: AppUIMessageChunk) {
    if (this.closed) return
    this.chunks.push(chunk)
    for (const listener of [...this.listeners]) listener(chunk)
  }

  subscribe(listener: Listener) {
    for (const chunk of this.chunks) listener(chunk)
    if (this.closed) {
      listener(null)
      return () => undefined
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  finish() {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.listeners]) listener(null)
    this.listeners.clear()
  }

  get finished() {
    return this.closed
  }
}
