import { describe, expect, it } from 'vitest'
import { RunStream } from '../src/runs/run-stream'

describe('RunStream replay', () => {
  it('replays more than 400 public chunks without dropping the beginning', () => {
    const stream = new RunStream('run-replay')
    stream.emit({ type: 'text-start', id: 'text:1' })
    for (let index = 0; index < 450; index += 1) {
      stream.emit({ type: 'text-delta', id: 'text:1', delta: String(index % 10) })
    }
    stream.emit({ type: 'text-end', id: 'text:1' })
    stream.finish()

    const replay: string[] = []
    stream.subscribe((chunk) => {
      if (chunk) replay.push(chunk.type)
    })
    expect(replay).toHaveLength(452)
    expect(replay[0]).toBe('text-start')
    expect(replay[451]).toBe('text-end')
  })
})
