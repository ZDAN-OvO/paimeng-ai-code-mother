/**
 * 跑一条测评用例：注册临时账号 → 创建应用 → 发送首轮与 follow-up → 等终态 →
 * 抓转录、用量、源码与预览证据。模型质量判断不在这里做，见 ../rubric.md 与 ../judge/。
 *
 * 用法（在 paimeng-ai-code-agent/ 下，应用、harness、预览服务需已启动）：
 *   npx tsx evals/scripts/run-case.ts --list
 *   npx tsx evals/scripts/run-case.ts --case smoke-01-html-portfolio
 *   npx tsx evals/scripts/run-case.ts --case adv-06-ask-salary --out runtime/evals
 *   npx tsx evals/scripts/run-case.ts --case multi-01-additive --dry-run
 *
 * 安全与成本：
 * - 默认只允许本机 base；真实模型会消耗 Credit，跑之前确认模型配置。
 * - 每个用例用独立临时账号，不触碰现有用户数据。
 * - 产物写到 runtime/evals/（已被 gitignore），不提交。
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { loadCases } from './schema';
import { probePreview } from './probe';

const evalRoot = fileURLToPath(new URL('..', import.meta.url));
const appRoot = resolve(evalRoot, '..');
try {
  loadEnvFile(join(appRoot, '.env'));
} catch {
  // 没有 .env 时仍可用 --base 指向一个显式地址。
}
const datasetDir = join(evalRoot, 'datasets');
const DEFAULT_PASSWORD = 'eval-password-123';

type Envelope<T> = { code: number; data: T; message?: string };
type GenerationStatus = {
  id: string;
  status: 'generating' | 'building' | 'ready' | 'failed' | 'cancelled';
  error: string | null;
  stopReason: string | null;
  question?: { id: string; prompt: string } | null;
};
type AppInfo = { id: string; appName: string | null; codeGenType: string; template?: { id: string; version: string } | null; previewUrl?: string | null };
type StreamEvent = {
  at: number;
  type: string;
  stage?: string;
  status?: string;
  toolName?: string;
  ms?: number;
  error?: string;
};
type Draining = { bytes: number; chunks: number; textDeltas: number; events: StreamEvent[]; dropped: number; errors: string[] };

class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: number) {
    super(message);
  }
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function flag(name: string) {
  return process.argv.includes(name);
}
function sleep(ms: number) {
  return new Promise<void>(done => setTimeout(done, ms));
}
function timestamp() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function main() {
  let loaded: Awaited<ReturnType<typeof loadCases>>;
  try {
    loaded = await loadCases(datasetDir);
  } catch (error) {
    console.error(`测评集加载失败：${(error as Error).message}`);
    process.exit(2);
  }

  if (flag('--list')) {
    for (const { suite, cases } of loaded) {
      console.log(`${suite.suite}  ${suite.title}`);
      for (const item of cases) console.log(`  ${item.id.padEnd(28)} ${item.execution === 'manual' ? '[手工]' : '[自动]'} ${item.title}`);
    }
    return;
  }

  const caseId = arg('--case');
  if (!caseId) {
    console.error('用法：--case <用例 id>，或 --list');
    process.exit(2);
  }
  const found = loaded.flatMap(entry => entry.cases.map(item => ({ suite: entry.suite.suite, item }))).find(entry => entry.item.id === caseId);
  if (!found) {
    console.error(`找不到用例 ${caseId}。可用 --list 查看。`);
    process.exit(2);
  }
  const { suite, item } = found;

  if (item.execution === 'manual') {
    console.error(`${item.id} 是手工用例（steer / 版本恢复），runner 不代跑。协议见 evals/README.md。`);
    process.exit(2);
  }

  const base = (arg('--base') ?? process.env.APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
  const baseUrl = new URL(base);
  const local = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
  if (!local && !flag('--allow-remote')) {
    console.error(`拒绝在非本机地址 ${base} 上跑测评。确需如此请加 --allow-remote，并确认不是生产库。`);
    process.exit(2);
  }

  const runId = arg('--run-id') ?? timestamp();
  const outRoot = resolve(arg('--out') ?? join(appRoot, 'runtime/evals'));
  const caseDir = join(outRoot, runId, item.id);
  const caseHash = createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16);

  if (flag('--dry-run')) {
    console.log(JSON.stringify({
      case: item.id,
      suite,
      caseHash,
      codeGenType: item.codeGenType,
      templateId: item.templateId,
      signals: item.signals,
      steps: [{ kind: 'start', text: item.prompt }, ...item.followUps.map(followUp => ({ kind: followUp.kind, text: followUp.text }))],
    }, null, 2));
    return;
  }

  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'case.json'), JSON.stringify({ suite, ...item, caseHash }, null, 2), 'utf8');

  const account = `eval_${runId.replace(/[^0-9]/g, '').slice(-10)}_${randomUUID().slice(0, 4)}`;
  const context = new Session(base, account, DEFAULT_PASSWORD);
  console.log(`[${item.id}] 账号 ${account} → ${base}`);
  await context.login();

  const created = await context.call<string>('app/add', 'POST', {
    initPrompt: item.prompt,
    ...(item.templateId ? { templateId: item.templateId } : {}),
  });
  const appId = created;
  if (!appId) throw new Error('app/add 没有返回应用 ID');
  console.log(`[${item.id}] 应用 ${appId}，类型 ${item.codeGenType}`);

  const steps = [{ kind: 'start' as const, text: item.prompt, after: undefined as string | undefined },
    ...item.followUps.map(followUp => ({ kind: followUp.kind, text: followUp.text, after: followUp.after }))];
  const records: unknown[] = [];
  const runStartedAt = new Date().toISOString();
  let finalApp: AppInfo | null = null;
  let blocked = false;

  for (const [index, step] of steps.entries()) {
    const stepNo = index + 1;
    const dir = join(caseDir, `step-${String(stepNo).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });
    console.log(`[${item.id}] 第 ${stepNo}/${steps.length} 步：${step.kind} …`);

    let status: GenerationStatus | null = null;
    let questionId: string | undefined;
    if (step.kind === 'answer') {
      const current = await context.call<GenerationStatus | null>(`app/generation?appId=${encodeURIComponent(appId)}`);
      questionId = current?.question?.id;
      if (!questionId) {
        blocked = true;
        await writeFile(join(dir, 'blocked.json'), JSON.stringify({ reason: 'answer 步骤没有等待回答的问题', current }, null, 2));
        console.error(`[${item.id}] 第 ${stepNo} 步被阻塞：当前没有 open question`);
        break;
      }
    }

    const startedAt = Date.now();
    const deadline = startedAt + item.signals.maxMinutes * 60_000 + 60_000;
    const before = await context.call<GenerationStatus | null>(`app/generation?appId=${encodeURIComponent(appId)}`).catch(() => null);
    const beforeId = before?.id;
    const requestId = randomUUID();
    let draining: Draining;
    let streamFailed = false;
    try {
      draining = await context.stream('app/chat/gen/code', {
        appId,
        requestId,
        message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: step.text }] },
        ...(questionId ? { expectedQuestionId: questionId } : {}),
      }, deadline);
    } catch (error) {
      streamFailed = true;
      draining = { bytes: 0, chunks: 0, textDeltas: 0, events: [], dropped: 0, errors: [(error as Error).message] };
      console.error(`[${item.id}] 流中断：${(error as Error).message}`);
    }
    await writeFile(join(dir, 'events.json'), JSON.stringify(draining, null, 2), 'utf8');

    status = await waitTerminal(context, appId, streamFailed ? Date.now() + 10_000 : deadline, beforeId);
    const finishedAt = Date.now();
    const terminal = status !== null && ['ready', 'failed', 'cancelled'].includes(status.status);
    if (!terminal) {
      await context.call('app/generation/cancel', 'POST', { appId }).catch(() => undefined);
      status = await waitTerminal(context, appId, Date.now() + 30_000, beforeId);
      blocked = true;
    }
    await writeFile(join(dir, 'generation.json'), JSON.stringify(status, null, 2), 'utf8');

    const app = await context.call<AppInfo>(`app/get/vo?id=${encodeURIComponent(appId)}`);
    finalApp = app;
    await writeFile(join(dir, 'app.json'), JSON.stringify(app, null, 2), 'utf8');
    await context.call<unknown>(`app/messages?appId=${encodeURIComponent(appId)}`)
      .then(messages => writeFile(join(dir, 'transcript.json'), JSON.stringify(messages, null, 2), 'utf8'))
      .catch(error => writeFile(join(dir, 'transcript-error.txt'), String(error), 'utf8'));
    await context.call<unknown>(`app/generation/accounts?appId=${encodeURIComponent(appId)}&limit=10`)
      .then(accounts => writeFile(join(dir, 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf8'))
      .catch(() => undefined);

    const source = await copySource(app.codeGenType, appId, join(dir, 'source'));
    let probe: unknown = null;
    if (app.previewUrl) {
      try {
        probe = await probePreview(app.previewUrl, join(dir, 'probe'));
      } catch (error) {
        probe = { error: (error as Error).message };
        await writeFile(join(dir, 'probe-error.txt'), (error as Error).stack ?? String(error), 'utf8');
        console.error(`[${item.id}] 预览取证失败：${(error as Error).message}`);
      }
    }

    records.push({
      step: stepNo,
      kind: step.kind,
      text: step.text,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      seconds: Math.round((finishedAt - startedAt) / 1000),
      generation: status,
      previewUrl: app.previewUrl ?? null,
      sourceFiles: source.files,
      sourceBytes: source.bytes,
      envFiles: source.envFiles,
      probe: probe ? summarizeProbe(probe) : null,
    });
    console.log(`[${item.id}] 第 ${stepNo} 步 ${status?.status ?? 'unknown'}${status?.stopReason ? `/${status.stopReason}` : ''}，${Math.round((finishedAt - startedAt) / 1000)}s，预览 ${app.previewUrl ?? '无'}`);

    if (status?.stopReason === 'question') {
      const next = steps[index + 1];
      if (!next || next.kind !== 'answer') {
        blocked = true;
        console.error(`[${item.id}] 模型提问但用例没有 answer 步骤，停止`);
        break;
      }
      continue;
    }
    if (streamFailed && !status) {
      console.error(`[${item.id}] 请求没有建立生成，停止后续步骤`);
      break;
    }
    if (status && status.status !== 'ready') {
      console.error(`[${item.id}] 第 ${stepNo} 步未到达 ready，停止后续步骤`);
      break;
    }
  }

  const result = {
    case: item.id,
    title: item.title,
    suite,
    caseHash,
    appId,
    account,
    base,
    runId,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    outcome: blocked ? 'blocked' : records.length === steps.length ? 'collected' : 'incomplete',
    app: finalApp,
    steps: records,
    artifactRoot: caseDir,
    next: '按 evals/rubric.md 用 evals/judge/*.md 判分；截图与源码都在本目录。',
  };
  await writeFile(join(caseDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  await writeFile(join(caseDir, 'credentials.json'), JSON.stringify({ account, password: DEFAULT_PASSWORD, appId }, null, 2), 'utf8');
  console.log(`\n[${item.id}] 完成：${result.outcome}`);
  console.log(`  应用 ${appId}｜预览 ${finalApp?.previewUrl ?? '无'}`);
  console.log(`  证据 ${caseDir}`);
  if (blocked) process.exitCode = 3;
}

class Session {
  private cookie = '';
  constructor(private readonly base: string, private readonly account: string, private readonly password: string) {}

  private headers(json: boolean) {
    return {
      origin: this.base,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.cookie ? { cookie: this.cookie } : {}),
    };
  }

  private async request(path: string, init: RequestInit) {
    return fetch(new URL(`/api/${path}`, this.base), init);
  }

  async login() {
    const body = { userAccount: this.account, userPassword: this.password };
    const register = await this.request('user/register', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ ...body, checkPassword: this.password }),
    });
    if (!register.ok) {
      const payload = await register.clone().json().catch(() => null) as Envelope<unknown> | null;
      if (payload?.code !== 40000 || !String(payload.message).includes('已存在')) {
        throw new HttpError(`注册失败：${payload?.message ?? register.statusText}`, register.status, payload?.code ?? 0);
      }
    }
    const login = await this.request('user/login', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!login.ok) throw new HttpError(`登录失败：${login.statusText}`, login.status, 0);
    const cookies = login.headers.getSetCookie?.() ?? [];
    const session = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('paimeng_ts_session='));
    if (!session) throw new Error('登录成功但响应没有会话 Cookie');
    this.cookie = session;
  }

  async call<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
    const response = await this.request(path, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => null) as Envelope<T> | null;
    if (!response.ok || !payload || payload.code !== 0) {
      throw new HttpError(`${method} ${path} 失败：${payload?.message ?? response.statusText}`, response.status, payload?.code ?? 0);
    }
    return payload.data;
  }

  async stream(path: string, body: unknown, deadline: number): Promise<Draining> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('step timeout')), Math.max(1000, deadline - Date.now()));
    const result: Draining = { bytes: 0, chunks: 0, textDeltas: 0, events: [], dropped: 0, errors: [] };
    try {
      const response = await this.request(path, {
        method: 'POST',
        headers: { ...this.headers(true), accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as Envelope<unknown> | null;
        throw new HttpError(`生成请求失败：${payload?.message ?? response.statusText}`, response.status, payload?.code ?? 0);
      }
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = '';
      const toolNames = new Map<string, string>();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result.bytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          result.chunks += 1;
          const type = typeof chunk.type === 'string' ? chunk.type : '';
          if (type === 'text-delta') {
            result.textDeltas += 1;
            continue;
          }
          if (result.events.length >= 4000) {
            result.dropped += 1;
            continue;
          }
          const at = Date.now();
          if (type === 'data-progress') {
            const data = (chunk.data ?? {}) as Record<string, unknown>;
            result.events.push({ at, type: 'progress', stage: String(data.stage ?? ''), status: String(data.status ?? ''), ms: Number(data.ms ?? 0) });
          } else if (type === 'tool-input-available') {
            const name = String(chunk.toolName ?? '');
            const id = String(chunk.toolCallId ?? '');
            if (id) toolNames.set(id, name);
            result.events.push({ at, type: 'tool-call', toolName: name });
          } else if (type === 'tool-output-available' || type === 'tool-output-error') {
            const id = String(chunk.toolCallId ?? '');
            result.events.push({
              at,
              type: 'tool-result',
              toolName: toolNames.get(id) ?? String(chunk.toolName ?? ''),
              ...(type === 'tool-output-error' ? { error: String(chunk.errorText ?? '').slice(0, 500) } : {}),
            });
          } else if (type === 'error') {
            result.errors.push(String(chunk.errorText ?? chunk.error ?? 'unknown').slice(0, 500));
            result.events.push({ at, type: 'error', error: result.errors.at(-1) });
          } else if (type === 'start' || type === 'finish' || type === 'finish-step') {
            result.events.push({ at, type });
          }
        }
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function waitTerminal(session: Session, appId: string, deadline: number, afterId?: string): Promise<GenerationStatus | null> {
  let last: GenerationStatus | null = null;
  while (Date.now() < deadline) {
    const status = await session.call<GenerationStatus | null>(`app/generation?appId=${encodeURIComponent(appId)}`).catch(() => null);
    if (status && status.id !== afterId) {
      last = status;
      if (status.status === 'ready' || status.status === 'failed' || status.status === 'cancelled') return status;
    }
    await sleep(1500);
  }
  return last;
}

async function copySource(codeGenType: string, appId: string, dest: string) {
  const source = join(appRoot, 'runtime/code_output', `${codeGenType}_${appId}`);
  const result = { files: 0, bytes: 0, skipped: false, envFiles: [] as string[] };
  try {
    await stat(source);
  } catch {
    result.skipped = true;
    return result;
  }
  result.envFiles = await findEnvFiles(source, source);
  await mkdir(dest, { recursive: true });
  await cp(source, dest, {
    recursive: true,
    // .env 可能含密钥：不复制内容，只记录路径，交给 judge 判 H3/S1。
    filter: input => !/(^|[/\\])(node_modules|\.git|dist|coverage|\.next|\.env)([/\\]|$)|(^|[/\\])\.env\.[^/\\]+$/.test(input),
  });
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        result.files += 1;
        result.bytes += (await stat(path)).size;
      }
    }
  };
  await walk(dest);
  return result;
}

async function findEnvFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/(^|[/\\])(node_modules|\.git|dist|coverage|\.next)([/\\]|$)/.test(path)) continue;
      found.push(...await findEnvFiles(root, path));
    } else if (entry.isFile() && /^\.env(\..+)?$/.test(entry.name)) {
      found.push(path.slice(root.length + 1));
    }
  }
  return found;
}

function summarizeProbe(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const probe = value as {
    desktop?: { title?: string; issues?: { horizontalOverflow?: number; imagesWithoutAlt?: unknown[]; inputsWithoutName?: unknown[]; contrast?: unknown[]; smallTapTargets?: unknown[] }; errors?: { console?: unknown[]; page?: unknown[] }; network?: { failures?: unknown[]; externalHosts?: unknown[] } };
    mobile?: { issues?: { horizontalOverflow?: number; smallTapTargets?: unknown[] } };
    screenshots?: unknown;
  };
  return {
    title: probe.desktop?.title ?? '',
    desktop: {
      horizontalOverflow: probe.desktop?.issues?.horizontalOverflow ?? null,
      imagesWithoutAlt: probe.desktop?.issues?.imagesWithoutAlt?.length ?? null,
      inputsWithoutName: probe.desktop?.issues?.inputsWithoutName?.length ?? null,
      contrastIssues: probe.desktop?.issues?.contrast?.length ?? null,
      smallTapTargets: probe.desktop?.issues?.smallTapTargets?.length ?? null,
      consoleErrors: probe.desktop?.errors?.console?.length ?? null,
      pageErrors: probe.desktop?.errors?.page?.length ?? null,
      failedRequests: probe.desktop?.network?.failures?.length ?? null,
      externalHosts: probe.desktop?.network?.externalHosts ?? [],
    },
    mobile: {
      horizontalOverflow: probe.mobile?.issues?.horizontalOverflow ?? null,
      smallTapTargets: probe.mobile?.issues?.smallTapTargets?.length ?? null,
    },
  };
}

await main().catch(error => {
  console.error(error instanceof HttpError ? `${error.message}（HTTP ${error.status}/${error.code}）` : error);
  process.exitCode = 1;
});
