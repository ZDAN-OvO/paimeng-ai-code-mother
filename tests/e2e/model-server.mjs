import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

export async function readJson(req) {
  let size = 0
  const parts = []
  for await (const part of req) {
    size += part.length
    if (size > 2 * 1024 * 1024) throw new Error('fixture request too large')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
}

export function createModelServer() {
  const scenarios = new Map()
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    })
  })
  server.requestTimeout = 25_000
  server.headersTimeout = 5_000
  server.timeout = 25_000

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fixture')
    if (url.pathname === '/__control/scenarios' && req.method === 'POST') {
      const { marker, mode = 'normal', steer = '' } = await readJson(req)
      if (!/^e2e-[a-f0-9]{32}$/.test(marker) || !['normal', 'hold', 'fail'].includes(mode) ||
          typeof steer !== 'string' || steer.length > 100) throw new Error('invalid scenario')
      if (scenarios.has(marker)) throw new Error('duplicate scenario')
      const partial = `正在生成 ${marker}。`
      scenarios.set(marker, {
        marker, mode, steer, partial, phase: 0, requests: 0, waiting: false,
        aborted: false, seenSteer: false, calls: [], failureSent: false,
      })
      return json(res, { marker, partial })
    }
    const control = /^\/__control\/scenarios\/(e2e-[a-f0-9]{32})(\/release)?$/.exec(url.pathname)
    if (control) {
      const scenario = scenarios.get(control[1])
      if (!scenario) return json(res, {}, 404)
      if (req.method === 'DELETE') {
        scenario.abort?.()
        scenarios.delete(control[1])
        return json(res, { deleted: true })
      }
      if (req.method === 'POST' && control[2]) {
        scenario.release?.()
        return json(res, { released: true })
      }
      if (req.method !== 'GET' || control[2]) return json(res, {}, 405)
      const { release, abort, ...state } = scenario
      return json(res, state)
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/responses') return json(res, {}, 404)
    const body = await readJson(req)
    if (body.stream !== true || body.model !== 'paimeng-e2e-fixed') throw new Error('unexpected model request')
    const wire = JSON.stringify(body.input)
    const scenario = [...scenarios.values()].find((item) => wire.includes(item.marker))
    if (!scenario) throw new Error('unregistered model scenario')
    scenario.requests++
    // 只有后端发来的模型请求包含插话，才把它写进 HTML 和最终回复，防止伪造“已消费”。
    scenario.seenSteer ||= Boolean(scenario.steer && (body.input ?? []).some((item) =>
      item.role === 'user' && JSON.stringify(item.content).includes(scenario.steer)))
    const held = scenario.mode === 'hold' && scenario.requests === 1
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const id = `resp_${randomUUID()}`
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ type: 'response.created', response: { id, created_at: 1, model: body.model } })
    if (held) {
      // 中间文本只存在于流里，从不落库：页面能看到它，就证明 SSE 真的在推流。
      const partialId = `msg_${randomUUID()}`
      send({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: partialId, role: 'assistant', status: 'in_progress', content: [] } })
      send({ type: 'response.output_text.delta', item_id: partialId, output_index: 0,
        content_index: 0, delta: scenario.partial })
      const released = await new Promise((resolve) => {
        let settled = false
        const finish = (ok) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          res.off('close', closed)
          scenario.waiting = false
          delete scenario.release
          delete scenario.abort
          resolve(ok)
        }
        const closed = () => { scenario.aborted = true; finish(false) }
        const timer = setTimeout(() => {
          scenario.aborted = true
          res.destroy(new Error('fixture gate exceeded 20 seconds'))
          finish(false)
        }, 20_000)
        scenario.release = () => finish(true)
        scenario.abort = () => { res.destroy(); closed() }
        scenario.waiting = true
        res.once('close', closed)
      })
      if (!released) return
      send({ type: 'response.output_item.done', output_index: 0,
        item: { type: 'message', id: partialId, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: scenario.partial, annotations: [] }] } })
    }
    if (scenario.mode === 'fail' && !scenario.failureSent) {
      scenario.failureSent = true
      send({ type: 'response.failed', sequence_number: 1,
        response: { error: { code: 'server_error', message: `模型故障 ${scenario.marker}` } } })
      return res.end()
    }
    const steps = [{ id: 'page', title: '生成静态页面', status: 'in_progress' }]
    const suffix = scenario.seenSteer ? `；已应用插话：${scenario.steer}` : ''
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>生成结果</title>` +
      `<body><h1>${scenario.marker}</h1><p>页面已生成${suffix}</p></body></html>`
    let call
    if (scenario.phase === 0) call = { name: 'update_plan', input: { steps } }
    else if (scenario.phase === 1) call = { name: 'write', input: { path: 'index.html', content: html } }
    if (call) {
      // 每轮请求必须携带上一个真实工具结果；工具失败不能继续伪造成功。
      if (scenario.phase > 0) requireToolResult(body.input, scenario.lastCall)
      scenario.calls.push(call.name)
      const callId = `call_${randomUUID()}`
      const item = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: callId,
        name: call.name, arguments: JSON.stringify(call.input), status: 'completed' }
      const outputIndex = held ? 1 : 0
      send({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '' } })
      send({ type: 'response.function_call_arguments.delta', item_id: item.id,
        output_index: outputIndex, delta: item.arguments })
      send({ type: 'response.output_item.done', output_index: outputIndex, item })
      scenario.lastCall = callId
      scenario.phase++
    } else {
      requireToolResult(body.input, scenario.lastCall)
      const text = `页面已完成 ${scenario.marker}${suffix}`
      const item = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0,
        content_index: 0, delta: text })
      send({ type: 'response.output_item.done', output_index: 0, item })
    }
    send({ type: 'response.completed', response: { id, status: 'completed',
      usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  }
  return server
}

function requireToolResult(input, callId) {
  const result = input.find((item) => item.type === 'function_call_output' && item.call_id === callId)
  if (!result || /"error"\s*:/.test(String(result.output))) throw new Error('missing or failed real tool result')
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
