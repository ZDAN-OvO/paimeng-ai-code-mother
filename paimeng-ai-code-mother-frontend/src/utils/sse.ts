export interface SseMessage {
  event: string
  data: string
}

export interface SseParser {
  push: (chunk: string) => void
  flush: () => void
}

/**
 * 解析符合 SSE 规范的事件流。
 * 支持 CRLF/CR/LF、跨分片事件、多行 data、注释心跳和末尾无空行的收尾块。
 */
export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = ''
  let started = false

  const dispatch = (block: string) => {
    let eventName = ''
    const dataLines: string[] = []
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue
      const separator = line.indexOf(':')
      const field = separator >= 0 ? line.slice(0, separator) : line
      let value = separator >= 0 ? line.slice(separator + 1) : ''
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') eventName = value
      else if (field === 'data') dataLines.push(value)
    }
    if (!eventName || dataLines.length === 0) return
    onMessage({ event: eventName, data: dataLines.join('\n') })
  }

  const drain = () => {
    let match = /\r\n\r\n|\r\r|\n\n/.exec(buffer)
    while (match) {
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      dispatch(block)
      match = /\r\n\r\n|\r\r|\n\n/.exec(buffer)
    }
  }

  return {
    push(chunk: string) {
      if (!started) {
        started = true
        if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
      }
      buffer += chunk
      drain()
    },
    flush() {
      if (buffer.trim()) dispatch(buffer)
      buffer = ''
    },
  }
}
