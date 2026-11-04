// Repeatable baseline load probe. Owns only its child processes and uniquely named _test records.

import { spawn } from 'node:child_process';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  loadEnvFile(join(root, '.env'));
} catch {
  // 允许从已有环境变量运行，不要求本地 .env 文件。
}
const runId = randomUUID().slice(0, 8),
  output = join(root, 'runtime', 'queue-stress', runId);
const originalTsconfig = await readFile(join(root, 'tsconfig.json'), 'utf8');
await mkdir(output, { recursive: true });
const report = {
  runId,
  startedAt: new Date().toISOString(),
  scope: 'baseline, no queue replacement or product fixes',
  scenarios: [],
  samples: [],
  events: [],
  safetyStops: [],
};
const children = [],
  inspectors = [],
  connections = new Set();
const scenarioBudgetMs = 120000;
let phase = 'setup',
  sampling = false,
  guardTripped = false,
  cookie = '',
  db,
  server,
  modelPlan = { bytes: 16384, chunk: 1024, interval: 20, hold: 0 },
  modelSequence = 0;
const pendingModels = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (event, data = {}) => {
  report.events.push({ at: new Date().toISOString(), event, ...data });
  console.log('[queue-stress]', event, JSON.stringify(data));
};
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const redact = (text) =>
  String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '<REDACTED_DATABASE_URL>')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <REDACTED>');
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
const appPort = await freePort(),
  harnessPort = await freePort(),
  modelPort = await freePort();
const appOrigin = `http://localhost:${appPort}`,
  harnessOrigin = `http://127.0.0.1:${harnessPort}`;
const productUrl = new URL(process.env.DATABASE_URL),
  storageUrl = new URL(process.env.DURABLE_PG_URL);
check(['/paimeng_app', '/paimeng_app_test'].includes(productUrl.pathname), 'Unexpected product DB');
check(
  ['/paimeng_agent', '/paimeng_agent_test'].includes(storageUrl.pathname),
  'Unexpected storage DB',
);
productUrl.pathname = '/paimeng_app_test';
storageUrl.pathname = '/paimeng_agent_test';
const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
redisUrl.pathname = '/15';
const env = {
  ...process.env,
  DATABASE_URL: productUrl.href,
  DURABLE_PG_URL: storageUrl.href,
  REDIS_URL: redisUrl.href,
  AI_MODE: 'fixture',
  ALLOW_TEST_FIXTURE: '1',
  AI_API_KEY: 'local-load-probe-only',
  AI_MODEL: 'local-load-model',
  AI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  APP_ORIGIN: appOrigin,
  PREVIEW_ORIGIN: `http://127.0.0.1:${await freePort()}`,
  DURABLE_HARNESS_URL: harnessOrigin,
  DURABLE_HARNESS_HOST: '127.0.0.1',
  DURABLE_HARNESS_PORT: String(harnessPort),
  DURABLE_HARNESS_RUN_DIR: join(output, 'harness'),
  DURABLE_HARNESS_WORKSPACE: join(output, 'workspace'),
  DURABLE_HARNESS_RESET: '0',
  DURABLE_FAUX_MODEL: '0',
  DURABLE_FAUX_FIXTURE: '0',
  DURABLE_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  DURABLE_MODEL_API_KEY: 'local-load-probe-only',
  DURABLE_MODEL_ID: 'local-load-model',
  CHAT_RATE_LIMIT_TYPE: 'USER',
  CHAT_RATE_LIMIT_RATE: '1000',
  CHAT_RATE_LIMIT_INTERVAL: '1',
  GENERATION_MAX_CONCURRENT: '4',
  GENERATION_TIMEOUT_MS: '120000',
  NEXT_DIST_DIR: '.next/queue-stress',
  NODE_OPTIONS: '--max-old-space-size=768',
};

async function child(name, args, extra = {}) {
  let text = '',
    ws;
  const c = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) =>
    c.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const record = {
    name,
    c,
    exited,
    get ws() {
      return ws;
    },
    get text() {
      return text;
    },
  };
  children.push(record);
  const capture = (buffer) => {
    const chunk = redact(buffer.toString());
    text = (text + chunk).slice(-32000);
    const match = text.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f\d-]+/);
    if (match) ws = match[0];
    void import('node:fs').then((fs) => fs.appendFileSync(join(output, `${name}.log`), chunk));
  };
  c.stdout.on('data', capture);
  c.stderr.on('data', capture);
  c.on('error', (error) => log('child-error', { name, error: error.message }));
  return record;
}
async function waitHealthy(url, owned) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (owned.c.exitCode !== null)
      throw new Error(`${owned.name} exited: ${owned.text.slice(-1800)}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // 启动中的服务可能拒绝连接；在截止时间内重试。
    }
    await delay(200);
  }
  throw new Error(`Health timeout: ${owned.name}: ${owned.text.slice(-1800)}`);
}
async function inspector(owned) {
  for (let i = 0; i < 100 && !owned.ws; i++) await delay(50);
  check(owned.ws, `${owned.name} has no inspector`);
  const socket = new WebSocket(owned.ws),
    pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error('Inspector timeout'));
      }, 10000);
      pending.set(next, (response) => {
        clearTimeout(timer);
        response.error ? reject(new Error(response.error.message)) : resolve(response.result);
      });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const probe = {
    name: owned.name,
    socket,
    send,
    read: async () => {
      const result = await send('Runtime.evaluate', {
        expression:
          'JSON.stringify({memory:process.memoryUsage(),loop:performance.eventLoopUtilization(),activeObservers:globalThis.paimengGenerationObservers?.size??null})',
        returnByValue: true,
      });
      return { ...JSON.parse(result.result.value), io: await probe.io() };
    },
    io: async () => {
      const result = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__queueStressIO??{})',
        returnByValue: true,
      });
      return JSON.parse(result.result.value);
    },
  };
  const instrumentation = await send('Runtime.evaluate', {
    expression: `(()=>{const {ServerResponse}=process.getBuiltinModule('node:http');if(globalThis.__queueStressIOInstalled)return true;globalThis.__queueStressIOInstalled=true;const original=ServerResponse.prototype.write;ServerResponse.prototype.write=function(chunk,...args){const result=original.call(this,chunk,...args);const path=this.req?.url?.split('?')[0]||'unknown';if(!['/events','/agent-events','/api/app/chat/gen/code'].includes(path))return result;const metrics=globalThis.__queueStressIO??={};const item=metrics[path]??={calls:0,bytes:0,falseWrites:0,maxWritableBytes:0};item.calls++;item.bytes+=typeof chunk==='string'?Buffer.byteLength(chunk):chunk?.byteLength||0;if(!result)item.falseWrites++;item.maxWritableBytes=Math.max(item.maxWritableBytes,this.writableLength);return result;};globalThis.__queueStressIO={};return true;})()`,
    returnByValue: true,
  });
  check(
    !instrumentation.exceptionDetails && instrumentation.result?.value === true,
    'HTTP measurement instrumentation did not attach',
  );
  inspectors.push(probe);
  return probe;
}
async function sample(label = phase, required = false) {
  if (sampling) {
    if (!required) return;
    while (sampling) await delay(10);
  }
  sampling = true;
  try {
    const services = {};
    for (const probe of inspectors) services[probe.name] = await probe.read();
    const mem = await readFile('/proc/meminfo', 'utf8');
    const available = Number(/MemAvailable:\s+(\d+)/.exec(mem)[1]) * 1024;
    const database = (
      await db.query(
        "select count(*)::int as active from generation g join app a on a.id=g.app_id where a.user_id=$1 and g.status in ('generating','building')",
        [report.userId],
      )
    ).rows[0];
    const value = {
      at: new Date().toISOString(),
      phase: label,
      services,
      availableBytes: available,
      driver: process.memoryUsage(),
      localModelActive: pendingModels.size,
      database,
    };
    report.samples.push(value);
    const worst = Math.max(0, ...Object.values(services).map((s) => s.memory.rss));
    if ((worst > 900 * 1024 ** 2 || available < 2 * 1024 ** 3) && !guardTripped) {
      guardTripped = true;
      report.safetyStops.push({
        at: value.at,
        phase: label,
        worstRssBytes: worst,
        availableBytes: available,
      });
      log('safety-stop', { phase: label, worstRssMiB: Math.round(worst / 1024 ** 2) });
      for (const s of connections) s.destroy();
      for (const task of pendingModels) task.stop();
    }
    return value;
  } finally {
    sampling = false;
  }
}
const api = async (path, payload, timeout = 30000) => {
  const start = performance.now();
  const response = await fetch(appOrigin + '/api/' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      origin: appOrigin,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const json = await response.json();
  return {
    status: response.status,
    json,
    ms: performance.now() - start,
    headers: response.headers,
  };
};
async function newApp(label) {
  const result = await api('app/add', {
    initPrompt: `queue stress ${runId} ${label}`,
    templateId: 'html',
  });
  check(result.status === 200, `create app failed ${JSON.stringify(result.json)}`);
  return result.json.data;
}
function startGeneration(appId, mode = 'fast') {
  const requestId = randomUUID();
  let resolveHeaders;
  const headers = new Promise((resolve) => {
    resolveHeaders = resolve;
  });
  const completion = new Promise((resolve, reject) => {
    const body = JSON.stringify({
      appId,
      requestId,
      message: {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: `load ${runId} ${phase}` }],
      },
    });
    const req = httpRequest(
      appOrigin + '/api/app/chat/gen/code',
      {
        method: 'POST',
        headers: {
          origin: appOrigin,
          cookie,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let bytes = 0;
        connections.add(res);
        resolveHeaders({ status: res.statusCode, generationId: res.headers['x-generation-id'] });
        res.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.on('end', () => {
          connections.delete(res);
          resolve({ status: res.statusCode, bytes });
        });
        res.on('error', () => {
          connections.delete(res);
          resolve({ status: res.statusCode, bytes, disconnected: true });
        });
        res.on('close', () => {
          connections.delete(res);
          resolve({ status: res.statusCode, bytes, disconnected: !res.complete });
        });
        if (mode === 'paused') res.pause();
        if (mode === 'disconnect') setTimeout(() => res.destroy(), 150);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  completion.catch(() => {});
  return { requestId, headers, completion };
}
async function waitTerminal(appId, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await api(`app/generation?appId=${appId}`);
    if (
      result.status === 200 &&
      ['ready', 'failed', 'cancelled'].includes(result.json.data?.status)
    )
      return result.json.data;
    await delay(250);
  }
  throw new Error('generation terminal timeout');
}
async function cooldown(record) {
  phase = record.name + ':cooldown';
  await delay(6000);
  await sample(phase, true);
  record.naturalAfter = report.samples.at(-1);
  for (const probe of inspectors) await probe.send('HeapProfiler.collectGarbage');
  await sample(phase + ':gc', true);
  record.afterGc = report.samples.at(-1);
}
async function scenario(name, work) {
  const filter = process.env.STRESS_SCENARIOS?.split(',');
  if (filter && !filter.some((value) => name.startsWith(value))) return;
  if (guardTripped) return;
  for (const probe of inspectors)
    await probe.send('Runtime.evaluate', { expression: 'globalThis.__queueStressIO={}' });
  phase = name;
  const record = { name, startedAt: new Date().toISOString() };
  report.scenarios.push(record);
  record.before = await sample(phase, true);
  log('scenario-started', { name });
  try {
    let timer;
    try {
      await Promise.race([
        work(record),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Scenario budget exceeded')), scenarioBudgetMs);
        }),
      ]);
      record.completed = true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    record.error = redact(error.stack);
    log('scenario-error', { name, error: error.message });
    if (error.message === 'Scenario budget exceeded') throw error;
  }
  record.finishedAt = new Date().toISOString();
  await sample(name + ':end', true);
  record.end = report.samples.at(-1);
  await cooldown(record);
  log('scenario-finished', { name, completed: record.completed || false });
}
async function mapLimit(values, limit, work) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= values.length) return;
        await work(values[i], i);
      }
    }),
  );
}
function modelServer() {
  return httpServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const b of req) raw += b;
    try {
      JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const plan = { ...modelPlan },
      id = `load-${++modelSequence}`;
    let sent = 0,
      closed = false,
      timer;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (delta, finish = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'local-load-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          '\n\n',
      );
    const stop = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      pendingModels.delete(control);
      res.end();
    };
    const control = { stop };
    pendingModels.add(control);
    res.on('close', () => {
      closed = true;
      clearTimeout(timer);
      pendingModels.delete(control);
    });
    emit({ role: 'assistant', content: '' });
    const tick = () => {
      if (closed) return;
      if (sent >= plan.bytes) {
        emit({}, 'stop');
        res.write('data: [DONE]\n\n');
        stop();
        return;
      }
      const chunk = (
        `load-${id}-${String(sent).padStart(9, '0')}|` + 'abcdefghijklmnopqrstuvwxy '.repeat(100)
      ).slice(0, Math.min(plan.chunk, plan.bytes - sent));
      sent += chunk.length;
      emit({ content: chunk });
      timer = setTimeout(tick, plan.interval);
    };
    timer = setTimeout(tick, plan.hold);
  });
}
function watchConversation(conversationId, paused) {
  const record = { bytes: 0, headers: false };
  const req = httpRequest(`${harnessOrigin}/events?conversationId=${conversationId}`, (res) => {
    record.headers = true;
    record.res = res;
    connections.add(res);
    res.on('data', (chunk) => {
      record.bytes += chunk.length;
    });
    res.on('close', () => connections.delete(res));
    if (paused) res.pause();
  });
  req.on('error', () => {});
  req.end();
  record.close = () => {
    req.destroy();
    record.res?.destroy();
  };
  return record;
}
let interval;
const cleanup = async () => {
  clearInterval(interval);
  for (const connection of connections) connection.destroy();
  for (const task of pendingModels) task.stop();
  for (const probe of inspectors) probe.socket.close();
  for (const owned of [...children].reverse()) {
    if (owned.c.exitCode === null) {
      owned.c.kill('SIGTERM');
      await Promise.race([owned.exited, delay(3000)]);
      if (owned.c.exitCode === null) owned.c.kill('SIGKILL');
    }
  }
  await db?.end();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  const current = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')),
    original = JSON.parse(originalTsconfig);
  current.include = current.include.filter(
    (path) => original.include.includes(path) || !path.startsWith('.next/queue-stress/'),
  );
  if (JSON.stringify(current) === JSON.stringify(original))
    await writeFile(join(root, 'tsconfig.json'), originalTsconfig);
};
const interrupted = async () => {
  report.interrupted = true;
  await cleanup();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(130);
};
process.once('SIGTERM', () => void interrupted());
process.once('SIGINT', () => void interrupted());
try {
  db = new pg.Client({ connectionString: productUrl.href });
  await db.connect();
  const storage = new pg.Client({ connectionString: storageUrl.href });
  await storage.connect();
  const others = await storage.query(
    'select count(*)::int as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()',
  );
  await storage.end();
  check(others.rows[0].count === 0, 'The _test harness DB is in use; refusing to share/reset');
  // No reset, truncation, Redis flush or model-admin mutation.
  server = modelServer();
  await new Promise((resolve) => server.listen(modelPort, '127.0.0.1', resolve));
  log('build-started', {
    output,
    productDatabase: 'paimeng_app_test',
    storageDatabase: 'paimeng_agent_test',
  });
  if (process.env.STRESS_REUSE_BUILD === '1') {
    await readFile(join(root, '.next/queue-stress/BUILD_ID'));
    log('reusing-isolated-build');
  } else {
    const built = await child('build', ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
      NODE_OPTIONS: '--max-old-space-size=1536',
    });
    const buildResult = await built.exited;
    check(buildResult.code === 0, 'Build failed: ' + built.text.slice(-2000));
  }
  const harness = await child('harness', [
    '--inspect=127.0.0.1:0',
    '--import',
    'tsx',
    '--conditions=react-server',
    'src/server/generation/durable/harness-server.ts',
  ]);
  await waitHealthy(harnessOrigin + '/health', harness);
  const next = await child('next', [
    '--inspect=127.0.0.1:0',
    'node_modules/next/dist/bin/next',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(appPort),
  ]);
  await waitHealthy(appOrigin + '/api/health', next);
  await inspector(harness);
  await inspector(next);
  const account = 'stress_' + runId,
    password = randomBytes(18).toString('hex');
  const registered = await api('user/register', {
    userAccount: account,
    userPassword: password,
    checkPassword: password,
  });
  check(registered.status === 200, 'register failed');
  const signed = await api('user/login', { userAccount: account, userPassword: password });
  check(signed.status === 200, 'login failed');
  cookie = signed.headers.get('set-cookie').split(';')[0];
  report.userId = signed.json.data.id;
  report.configuration = {
    appPort,
    harnessPort,
    model: 'local streaming OpenAI-compatible stub',
    generationMaxConcurrent: 4,
    rateLimit: '1000/user/second, test only',
    nodeHeapLimitMiB: 768,
    safetyRssLimitMiB: 900,
    minHostAvailableMiB: 2048,
    build: 'isolated production build',
    resetDatabases: false,
  };
  interval = setInterval(
    () => void sample().catch((error) => log('sample-error', { message: error.message })),
    500,
  );
  await delay(1000);
  log('ready', report.configuration);
  await scenario('normal-1', async (r) => {
    modelPlan = { bytes: 65536, chunk: 1024, interval: 30, hold: 0 };
    const id = await newApp('normal');
    r.appIds = [id];
    const task = startGeneration(id);
    r.receipt = await task.headers;
    r.transfer = await task.completion;
    r.terminal = await waitTerminal(id);
  });
  await scenario('generation-admission-12', async (r) => {
    modelPlan = { bytes: 32768, chunk: 1024, interval: 30, hold: 3000 };
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await newApp('admission-' + i));
    r.appIds = ids;
    const start = performance.now();
    const tasks = ids.map((id) => startGeneration(id));
    r.receipts = await Promise.all(tasks.map((task) => task.headers));
    r.transfers = await Promise.all(tasks.map((task) => task.completion));
    r.elapsedMs = performance.now() - start;
    r.statuses = r.receipts.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
    r.terminals = await Promise.all(
      ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id)),
    );
  });
  await scenario('generation-admission-staggered-12', async (r) => {
    modelPlan = { bytes: 32768, chunk: 1024, interval: 30, hold: 6000 };
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await newApp('staggered-' + i));
    r.appIds = ids;
    const tasks = [];
    r.receipts = [];
    for (const id of ids) {
      const task = startGeneration(id);
      tasks.push(task);
      r.receipts.push(await task.headers);
    }
    r.transfers = await Promise.all(tasks.map((task) => task.completion));
    r.statuses = r.receipts.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
    r.terminals = await Promise.all(
      ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id)),
    );
  });
  for (const count of [100, 1000])
    await scenario('input-backlog-' + count, async (r) => {
      modelPlan = { bytes: 2048, chunk: 1024, interval: 30, hold: 60000 };
      const id = await newApp('inputs-' + count);
      r.appIds = [id];
      const task = startGeneration(id);
      r.receipt = await task.headers;
      check(r.receipt.status === 200, 'initial generation failed');
      const results = [],
        start = performance.now();
      await mapLimit(
        Array.from({ length: count }, (_, i) => i),
        8,
        async (i) => {
          results.push(
            await api(
              'app/chat/input',
              {
                appId: id,
                id: `${runId}-${count}-${i}`,
                mode: 'followUp',
                text: ('pending ' + i + ' ').padEnd(1000, 'x'),
              },
              60000,
            ),
          );
        },
      );
      r.enqueueElapsedMs = performance.now() - start;
      r.statuses = results.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
      r.latenciesMs = results.map((x) => x.ms).sort((a, b) => a - b);
      const grouped = await db.query(
        'select status,count(*)::int as count from generation_input where generation_id=$1 group by status',
        [r.receipt.generationId],
      );
      r.persistedInputs = grouped.rows;
      const duplicate = await api('app/chat/input', {
        appId: id,
        id: `${runId}-${count}-0`,
        mode: 'followUp',
        text: 'duplicate probe',
      });
      r.duplicateStatus = duplicate.status;
      r.cancel = await api('app/generation/cancel', { appId: id }, 60000);
      r.transfer = await task.completion;
      r.terminal = await waitTerminal(id);
      r.persistedAfterCancel = (
        await db.query(
          'select status,count(*)::int as count from generation_input where generation_id=$1 group by status',
          [r.receipt.generationId],
        )
      ).rows;
    });
  for (const [count, paused] of [
    [8, false],
    [8, true],
    [32, true],
    [64, true],
  ])
    await scenario(`watchers-${count}-${paused ? 'paused' : 'fast'}`, async (r) => {
      modelPlan = { bytes: 262144, chunk: 1024, interval: 30, hold: 1000 };
      const id = await newApp('watchers');
      r.appIds = [id];
      const task = startGeneration(id);
      r.receipt = await task.headers;
      check(r.receipt.status === 200, 'initial generation failed');
      const row = (
        await db.query('select conversation_id from generation_execution where generation_id=$1', [
          r.receipt.generationId,
        ])
      ).rows[0];
      check(row?.conversation_id, 'missing conversation');
      const watches = Array.from({ length: count }, () =>
        watchConversation(row.conversation_id, paused),
      );
      try {
        r.transfer = await task.completion;
        r.terminal = await waitTerminal(id);
        r.watchers = watches.map((w) => ({ headers: w.headers, bytesRead: w.bytes }));
        r.responseCharacters = (await api(`app/messages?appId=${id}`)).json.data?.length;
      } finally {
        for (const watch of watches) watch.close();
      }
    });
  await scenario('generation-clients-paused-4', async (r) => {
    modelPlan = { bytes: 1048576, chunk: 1024, interval: 10, hold: 500 };
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await newApp('paused-generation-' + i));
    r.appIds = ids;
    r.syntheticOutputBytesPerGeneration = modelPlan.bytes;
    r.exceedsAdvertisedModelOutput = true;
    const tasks = ids.map((id) => startGeneration(id, 'paused'));
    r.receipts = await Promise.all(tasks.map((task) => task.headers));
    try {
      r.terminals = await Promise.all(
        ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id, 60000)),
      );
      r.beforeDisconnect = await sample(r.name, true);
    } finally {
      for (const connection of [...connections]) connection.destroy();
    }
    r.transfers = await Promise.all(tasks.map((task) => task.completion));
  });
  for (const count of [4, 16])
    await scenario(`generation-clients-connected-${count}`, async (r) => {
      modelPlan = { bytes: 2097152, chunk: 1024, interval: 5, hold: 300 };
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(await newApp('connected-' + count + '-' + i));
      r.appIds = ids;
      r.syntheticOutputBytesPerGeneration = modelPlan.bytes;
      const tasks = ids.map((id) => startGeneration(id, 'fast'));
      r.receipts = await Promise.all(tasks.map((task) => task.headers));
      r.terminals = await Promise.all(
        ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id, 120000)),
      );
      r.ioAtEnd = (await sample(r.name, true)).services.next.io;
      r.transfers = await Promise.all(tasks.map((task) => task.completion));
    });
  for (const count of [4, 16])
    await scenario(`generation-clients-disconnected-${count}`, async (r) => {
      modelPlan = { bytes: 2097152, chunk: 1024, interval: 5, hold: 300 };
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(await newApp('disconnected-' + count + '-' + i));
      r.appIds = ids;
      r.syntheticOutputBytesPerGeneration = modelPlan.bytes;
      const tasks = ids.map((id) => startGeneration(id, 'disconnect'));
      r.receipts = await Promise.all(tasks.map((task) => task.headers));
      r.ioAtDisconnect = (await sample(r.name, true)).services.next.io;
      r.midpoint = await sample(r.name, true);
      r.terminals = await Promise.all(
        ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id, 120000)),
      );
      r.ioAtEnd = (await sample(r.name, true)).services.next.io;
      r.transfers = await Promise.all(tasks.map((task) => task.completion));
    });
  for (const [count, bytes, mode] of [
    [16, 131072, 'fast'],
    [64, 65536, 'fast'],
    [64, 65536, 'disconnect'],
  ])
    await scenario(`generation-budget-${count}-${bytes}-${mode}`, async (r) => {
      modelPlan = { bytes, chunk: 1024, interval: 5, hold: 300 };
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(await newApp(`budget-${count}-${mode}-${i}`));
      r.appIds = ids;
      r.syntheticOutputBytesPerGeneration = bytes;
      const tasks = ids.map((id) => startGeneration(id, mode));
      r.receipts = await Promise.all(tasks.map((task) => task.headers));
      r.terminals = await Promise.all(
        ids.filter((_, i) => r.receipts[i].status === 200).map((id) => waitTerminal(id, 120000)),
      );
      r.ioAtEnd = (await sample(r.name, true)).services.next.io;
      r.transfers = await Promise.all(tasks.map((task) => task.completion));
    });
  await scenario('generation-client-disconnect', async (r) => {
    modelPlan = { bytes: 65536, chunk: 1024, interval: 30, hold: 500 };
    const id = await newApp('disconnect');
    r.appIds = [id];
    const task = startGeneration(id, 'disconnect');
    r.receipt = await task.headers;
    r.transfer = await task.completion;
    r.terminal = await waitTerminal(id);
    const messages = await api(`app/messages?appId=${id}`);
    r.recoveredMessages = messages.json.data?.length;
    r.browserDisconnectedDidNotCancel = r.terminal.status === 'ready';
  });
  report.modelRequests = modelSequence;
  report.completed = true;
} catch (error) {
  report.error = redact(error.stack);
  log('run-error', { error: report.error });
  process.exitCode = 1;
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  for (const scenario of report.scenarios) {
    const samples = report.samples.filter(
      (s) => s.phase === scenario.name || s.phase === scenario.name + ':end',
    );
    scenario.maxModelActive = Math.max(0, ...samples.map((s) => s.localModelActive));
    scenario.maxDatabaseActive = Math.max(0, ...samples.map((s) => s.database?.active || 0));
    scenario.peaks = {};
    for (const name of ['harness', 'next']) {
      const values = samples.filter((s) => s.services[name]);
      if (values.length)
        scenario.peaks[name] = {
          rssBytes: Math.max(...values.map((s) => s.services[name].memory.rss)),
          heapUsedBytes: Math.max(...values.map((s) => s.services[name].memory.heapUsed)),
        };
    }
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  log('finished', {
    completed: report.completed || false,
    safetyStops: report.safetyStops.length,
    report: join(output, 'report.json'),
  });
}
