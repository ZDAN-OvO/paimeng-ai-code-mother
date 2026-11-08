import type {
  FileMap,
  Part,
  RunAccepted,
  RunStatus,
  SendMessageRequest,
  SiteState,
  SseEvent,
  TodoItem,
} from '@/shared/api/schemas';
import { changedPaths } from '@/lib/diff';
import { bytesOf } from '@/lib/format';
import { nowIso } from '@/lib/time';
import { canComplete, finishRound, skillKey, sourceRevision } from './flow';
import { uid } from './ids';
import { openRun, pushEvent, getRun, type EventRun } from './runs';
import { buildSiteFiles } from './seed/files';
import {
  ApiError,
  filesOf,
  findChat,
  getBundle,
  siteForChat,
  updateChat,
  updateMessage,
} from './world';

type Scenario = 'normal' | 'repair' | 'failure' | 'budget' | 'evidence' | 'tools' | 'skill-blocked';

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type SseEventInput = DistributiveOmit<SseEvent, 'seq'>;

type Ctx = {
  run: EventRun<SseEvent>;
  chatId: string;
  messageId: string;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function emit(ctx: Ctx, event: SseEventInput) {
  pushEvent(ctx.run, { ...event, seq: ctx.run.events.length + 1 } as SseEvent);
}

function addPart(ctx: Ctx, part: Part): Part {
  updateMessage(ctx.chatId, ctx.messageId, (message) => ({
    ...message,
    parts: [...message.parts, part],
  }));
  emit(ctx, { type: 'part-added', messageId: ctx.messageId, part });
  return part;
}

function patchPart(
  ctx: Ctx,
  partId: string,
  patch: { state?: 'running' | 'done' | 'error'; output?: string; items?: TodoItem[] },
) {
  updateMessage(ctx.chatId, ctx.messageId, (message) => ({
    ...message,
    parts: message.parts.map((part) => (part.id === partId ? { ...part, ...patch } : part)),
  }));
  emit(ctx, { type: 'part-updated', messageId: ctx.messageId, partId, patch });
}

function currentFiles(chatId: string): FileMap {
  return filesOf(findChat(chatId));
}

function setFiles(ctx: Ctx, files: FileMap) {
  updateChat(ctx.chatId, (chat) => ({ ...chat, liveFiles: { ...files } }));
}

function setSite(ctx: Ctx, site: SiteState) {
  updateChat(ctx.chatId, (chat) => ({ ...chat, liveSite: site }));
  emit(ctx, { type: 'preview', site, files: currentFiles(ctx.chatId) });
}

function scenarioFor(prompt: string): Scenario {
  if (/八项工具|文件工具/.test(prompt)) return 'tools';
  if (/脚本|scripts/.test(prompt)) return 'skill-blocked';
  if (/证据/.test(prompt)) return 'evidence';
  if (/验证失败|修复/.test(prompt)) return 'repair';
  if (/失败/.test(prompt)) return 'failure';
  if (/执行上限|上限/.test(prompt)) return 'budget';
  return 'normal';
}

export function wantsPlan(text: string) {
  return /先规划|先做计划|先出方案|不要.*写代码/.test(text);
}

function planRun(chatId: string): RunAccepted {
  return {
    messageId: findChat(chatId).messages.at(-1)?.id ?? '',
    eventsUrl: `/api/chats/${chatId}/events`,
  };
}

/* --------------------------------------------------------------- 入口 */

export function sendMessage(chatId: string, input: SendMessageRequest): RunAccepted {
  const chat = findChat(chatId);
  if (chat.streaming) throw new ApiError(409, '本轮还在生成，先停止或等它结束');
  if (chat.pendingPlan) throw new ApiError(409, '有方案在等审批，先批准、要求修改或拒绝');
  const parts: Part[] = [
    ...input.attachments.map((attachment) => ({
      id: uid('part'),
      type: 'image' as const,
      url: attachment.dataUrl,
      name: attachment.name,
    })),
    ...(input.text.trim() ? [{ id: uid('part'), type: 'text' as const, text: input.text }] : []),
    ...(input.selection
      ? [{ id: uid('part'), type: 'selection' as const, selection: input.selection }]
      : []),
  ];
  updateChat(chatId, (current) => ({
    ...current,
    updatedAt: nowIso(),
    messages: [...current.messages, { id: uid('msg'), role: 'user', parts, createdAt: nowIso() }],
  }));
  if (wantsPlan(input.text)) return proposePlan(chatId, input.text);
  return startRound(chatId, input.text);
}

export function proposePlan(
  chatId: string,
  prompt: string,
  revision = 1,
  feedback = '',
): RunAccepted {
  const messageId = uid('msg');
  const createdAt = nowIso();
  const plan: Part = {
    id: uid('part'),
    type: 'plan',
    revision,
    title: prompt || '本轮改动方案',
    steps: [
      '只读检查当前项目与相关技能，明确改动范围。',
      feedback ? `按反馈调整方案：${feedback}` : '保留现有视觉，修改必要组件与文案。',
      '验证当前修订并核对完成条件；未经批准不写入文件。',
    ],
    status: 'pending',
  };
  updateChat(chatId, (chat) => ({
    ...chat,
    updatedAt: createdAt,
    pendingPlan: { messageId, revision },
    messages: [
      ...chat.messages,
      {
        id: messageId,
        role: 'assistant',
        parts: [plan],
        createdAt,
        status: 'awaiting_approval',
      },
    ],
  }));

  const summary = '方案已提交，等待你批准、要求修改或拒绝。本轮没有修改项目文件。';
  const chat = findChat(chatId);
  const next = finishRound(
    chat,
    messageId,
    'awaiting_approval',
    summary,
    siteForChat(chat, chat.versions.length),
    uid('ver'),
    nowIso(),
  );
  updateChat(chatId, () => next);

  const run = openRun<SseEvent>(`chat:${chatId}`, { chatId, messageId });
  const ctx: Ctx = { run, chatId, messageId };
  const message = findChat(chatId).messages.find((item) => item.id === messageId) ?? null;
  emit(ctx, { type: 'snapshot', message });
  emit(ctx, {
    type: 'finish',
    messageId,
    status: 'awaiting_approval',
    summary,
    versionId: message?.versionId ?? null,
  });
  run.close();
  return planRun(chatId);
}

export function decidePlan(
  chatId: string,
  messageId: string,
  decision: 'approved' | 'changes_requested' | 'rejected',
  feedback?: string,
): RunAccepted {
  const chat = findChat(chatId);
  const pending = chat.pendingPlan;
  if (!pending || pending.messageId !== messageId) {
    throw new ApiError(409, '这条方案已经处理过，或不是当前待审的方案');
  }
  if (decision === 'changes_requested' && !feedback?.trim()) {
    throw new ApiError(400, '要求修改需要填写意见');
  }
  const plan = chat.messages
    .find((item) => item.id === messageId)
    ?.parts.find((part) => part.type === 'plan');
  const prompt = plan?.type === 'plan' ? plan.title : '';

  updateChat(chatId, (current) => ({
    ...current,
    pendingPlan: null,
    updatedAt: nowIso(),
    messages: current.messages.map((message) =>
      message.id !== messageId
        ? message
        : {
            ...message,
            status: decision === 'rejected' ? 'rejected' : 'succeeded',
            parts: message.parts.map((part) =>
              part.type === 'plan'
                ? { ...part, status: decision, feedback: feedback?.trim() || undefined }
                : part,
            ),
          },
    ),
  }));

  if (decision === 'approved') return startRound(chatId, prompt);
  if (decision === 'changes_requested') {
    return proposePlan(chatId, prompt, pending.revision + 1, feedback?.trim() ?? '');
  }

  const run = openRun<SseEvent>(`chat:${chatId}`, { chatId, messageId });
  const ctx: Ctx = { run, chatId, messageId };
  const message = findChat(chatId).messages.find((item) => item.id === messageId) ?? null;
  emit(ctx, { type: 'snapshot', message });
  emit(ctx, {
    type: 'finish',
    messageId,
    status: 'rejected',
    summary: '方案已拒绝，项目文件没有改动。',
    versionId: message?.versionId ?? null,
  });
  run.close();
  return planRun(chatId);
}

export function stopRun(chatId: string) {
  const run = getRun<SseEvent>(`chat:${chatId}`);
  if (run && !run.done) run.abort = true;
}

export function startRound(chatId: string, prompt: string): RunAccepted {
  const chat = findChat(chatId);
  if (chat.streaming) throw new ApiError(409, '本轮还在生成，先停止或等它结束');
  const previous = chat.versions.at(-1);
  const messageId = uid('msg');
  const createdAt = nowIso();
  updateChat(chatId, (current) => ({
    ...current,
    streaming: true,
    updatedAt: createdAt,
    liveFiles: { ...(previous?.files ?? {}) },
    liveSite: previous?.site,
    messages: [
      ...current.messages,
      {
        id: messageId,
        role: 'assistant',
        parts: [],
        createdAt,
        streaming: true,
        status: 'running',
      },
    ],
  }));

  const run = openRun<SseEvent>(`chat:${chatId}`, { chatId, messageId });
  const ctx: Ctx = { run, chatId, messageId };
  emit(ctx, {
    type: 'snapshot',
    message: findChat(chatId).messages.find((item) => item.id === messageId) ?? null,
  });
  void execute(ctx, prompt).catch((error) => {
    emit(ctx, { type: 'error', message: (error as Error).message });
    finalize(ctx, 'failed', '这一轮没有跑完，已保留当前的改动。');
  });
  return { messageId, eventsUrl: `/api/chats/${chatId}/events` };
}

function finalize(ctx: Ctx, status: RunStatus, summary: string) {
  const chat = findChat(ctx.chatId);
  const previous = chat.versions.at(-1);
  const next = finishRound(
    chat,
    ctx.messageId,
    status,
    summary,
    previous?.site ?? siteForChat(chat, chat.versions.length + 1),
    uid('ver'),
    nowIso(),
  );
  updateChat(ctx.chatId, () => next);
  updateMessage(ctx.chatId, ctx.messageId, (message) => ({
    ...message,
    parts: [
      ...message.parts.filter((part) => part.type !== 'text'),
      { id: uid('part'), type: 'text', text: summary },
    ],
  }));
  emit(ctx, {
    type: 'finish',
    messageId: ctx.messageId,
    status,
    summary,
    versionId: next.messages.find((item) => item.id === ctx.messageId)?.versionId ?? null,
  });
  ctx.run.close();
}

/* ----------------------------------------------------------- 一轮的剧情 */

async function execute(ctx: Ctx, prompt: string) {
  const chat = findChat(ctx.chatId);
  const previous = chat.versions.at(-1);
  const scenario = scenarioFor(prompt);
  const iteration =
    (previous && Object.keys(previous.files).length ? previous.site.iteration : 0) + 1;
  const site = siteForChat(chat, iteration);
  const lastUser = [...chat.messages].reverse().find((message) => message.role === 'user');
  const selection = lastUser?.parts.find((part) => part.type === 'selection');
  const quote = prompt.match(/[「“"]([^」”"]{2,18})[」”"]/)?.[1];
  if (quote && !selection) site.content.cta = quote;
  const target = buildSiteFiles(site);
  const research = /搜索|找两个|抓一下|联网|调研|参考的同类/.test(prompt);

  const todos: TodoItem[] = [
    { id: 'context', label: '读取项目与相关技能', status: 'in_progress' },
    {
      id: 'implement',
      label: research ? '查看调研示例与网页正文' : '修改项目文件',
      status: 'pending',
    },
    {
      id: 'verify',
      label: research ? '核对引用与未改代码的回复' : '检查当前修订并核对完成条件',
      status: 'pending',
    },
  ];
  const todoPart = addPart(ctx, { id: uid('part'), type: 'todos', items: todos });

  function progress(index: number) {
    const current = findChat(ctx.chatId)
      .messages.find((item) => item.id === ctx.messageId)
      ?.parts.find((part) => part.id === todoPart.id);
    const items =
      current?.type === 'todos'
        ? current.items.map((todo, i) => ({
            ...todo,
            status: (i < index ? 'completed' : i === index ? 'in_progress' : 'pending') as
              'completed' | 'in_progress' | 'pending',
          }))
        : todos;
    patchPart(ctx, todoPart.id, { items });
  }

  async function tool(
    name: string,
    input: Record<string, unknown>,
    output: string,
    error = false,
    mutate?: () => void,
  ) {
    if (ctx.run.abort) return false;
    const part = addPart(ctx, {
      id: uid('tool'),
      type: 'tool',
      name,
      state: 'running',
      input,
    });
    await wait(190);
    if (ctx.run.abort) return false;
    mutate?.();
    patchPart(ctx, part.id, { state: error ? 'error' : 'done', output });
    return true;
  }

  const stopped = () => {
    finalize(ctx, 'stopped', '已停止。已完成的改动保留为版本；未完成的任务保持原进度。');
  };

  addPart(ctx, {
    id: uid('part'),
    type: 'reasoning',
    text: '读取项目上下文，按需加载技能，再修改项目文件。',
  });

  const defaults = ['frontend-design', 'nextjs', 'shadcn', 'debug-and-verify'];
  const skills = getBundle(ctx.chatId).skills;
  const candidates = skills.filter(
    (skill) =>
      skill.enabled &&
      ((skill.source === 'builtin' && defaults.includes(skill.slug)) ||
        (skill.source === 'user' && (prompt.includes(skill.slug) || prompt.includes(skill.name)))),
  );
  for (const skill of candidates) {
    const loaded = await tool(
      'load_skill',
      { skill: skillKey(skill) },
      skill.contents?.['SKILL.md'] ??
        `${skill.name}\n${skill.description}\n按需读取参考文件；不提升权限。`,
    );
    if (!loaded) return stopped();
    const reference = skill.files.find((file) => file.startsWith('references/'));
    if (reference) {
      const read = await tool(
        'read_skill_file',
        { skill: skillKey(skill), path: reference },
        skill.contents?.[reference] ?? '保留项目视觉规范，并在结束前重新检查。',
      );
      if (!read) return stopped();
    }
  }

  const userSkill =
    candidates.find((skill) => skill.source === 'user') ??
    skills.find((skill) => skill.source === 'user' && skill.enabled);
  if (
    scenario === 'skill-blocked' ||
    (userSkill && !userSkill.trusted && /脚本|scripts/.test(prompt))
  ) {
    await tool(
      'run_command',
      {
        skill: userSkill ? skillKey(userSkill) : 'user:untrusted-demo',
        command: 'scripts/check.sh',
      },
      '执行被拒绝：技能尚未信任。没有执行脚本，也没有扩大网络权限。',
      true,
    );
    if (ctx.run.abort) return stopped();
    finalize(ctx, 'failed', '未信任的技能脚本被拒绝执行。可以到技能页核对文件并确认信任后重试。');
    return;
  }

  if (research) {
    progress(1);
    const searched = await tool(
      'search_web',
      { query: prompt },
      '1. 同类示例 A — https://slow-coffee.example\n2. 同类示例 B — https://beanmap.example',
    );
    if (!searched) return stopped();
    const fetched = await tool(
      'fetch_url',
      { url: 'https://slow-coffee.example' },
      '首屏一句话、明确行动按钮、下方为产品信息。固定示例，不实际联网。',
    );
    if (!fetched) return stopped();
    progress(2);
    const complete = await tool(
      'complete_task',
      { scope: 'research', revision: sourceRevision(currentFiles(ctx.chatId)) },
      '核对了引用与未改动的文件；调研结果不算代码验证。',
    );
    if (!complete) return stopped();
    progress(3);
    finalize(
      ctx,
      'succeeded',
      '调研完成，本轮没有改代码，仍追加一个源码快照版本。网页内容与引用是固定示例，不表示实际联网。',
    );
    return;
  }

  const firstPath = Object.keys(currentFiles(ctx.chatId))[0] ?? 'app/page.tsx';
  const globbed = await tool(
    'glob_files',
    { pattern: '**/*.{ts,tsx}' },
    Object.keys(currentFiles(ctx.chatId)).join('\n') || '当前工作区为空',
  );
  if (!globbed) return stopped();
  await tool('read_file', { path: firstPath }, currentFiles(ctx.chatId)[firstPath] ?? '尚未创建');
  await tool(
    'grep_files',
    { query: 'export', glob: '**/*.tsx' },
    '返回组件导出位置，用于确认改动范围。',
  );

  const attachments = lastUser?.parts.filter((part) => part.type === 'image') ?? [];
  if (attachments.length) {
    const read = await tool(
      'read_attachment',
      { name: attachments[0].name },
      '读取本轮图片作为视觉参考；版式分析是固定示例。',
    );
    if (!read) return stopped();
  }
  if (selection?.type === 'selection') {
    await tool(
      'read_file',
      { path: selection.selection.src, component: selection.selection.component },
      `本轮针对 ${selection.selection.label}，定位信息来自用户选中的元素。`,
    );
  }
  progress(1);

  if (scenario === 'tools') {
    const created = await tool('write_file', { path: 'note.txt' }, '创建示例文件', false, () =>
      setFiles(ctx, { ...currentFiles(ctx.chatId), 'note.txt': 'draft' }),
    );
    if (!created) return stopped();
    await tool(
      'edit_file',
      { path: 'note.txt', old: 'draft', replacement: 'reviewed' },
      '精确替换 draft → reviewed',
      false,
      () => setFiles(ctx, { ...currentFiles(ctx.chatId), 'note.txt': 'reviewed' }),
    );
    await tool(
      'move_file',
      { operation: 'copy', from: 'note.txt', to: 'note-copy.txt' },
      '复制到新路径，原文件保留',
      false,
      () =>
        setFiles(ctx, {
          ...currentFiles(ctx.chatId),
          'note-copy.txt': currentFiles(ctx.chatId)['note.txt'] ?? '',
        }),
    );
    await tool(
      'move_file',
      { operation: 'move', from: 'note-copy.txt', to: 'note-final.txt' },
      '移动完成',
      false,
      () => {
        const files: FileMap = {
          ...currentFiles(ctx.chatId),
          'note-final.txt': currentFiles(ctx.chatId)['note-copy.txt'] ?? '',
        };
        delete files['note-copy.txt'];
        setFiles(ctx, files);
      },
    );
    await tool(
      'delete_file',
      { path: 'note-final.txt', recursive: false },
      '只删除指定文件',
      false,
      () => {
        const files = { ...currentFiles(ctx.chatId) };
        delete files['note-final.txt'];
        setFiles(ctx, files);
      },
    );
    progress(2);
  }

  for (const path of changedPaths(previous?.files ?? {}, target)) {
    if (ctx.run.abort) return stopped();
    const exists = currentFiles(ctx.chatId)[path] !== undefined;
    const written = await tool(
      exists ? 'edit_file' : 'write_file',
      { path, bytes: bytesOf(target[path] ?? '') },
      exists ? '文件已修改' : '文件已创建',
      false,
      () => {
        const files = { ...currentFiles(ctx.chatId) };
        if (target[path] === undefined) delete files[path];
        else files[path] = target[path];
        setFiles(ctx, files);
      },
    );
    if (!written) return stopped();
  }
  if (ctx.run.abort) return stopped();
  setSite(ctx, site);

  if (scenario === 'budget') {
    finalize(
      ctx,
      'budget_exhausted',
      '已达到本轮执行上限，任务尚未完成。已保留完成的改动，但还没有通过验证。',
    );
    return;
  }

  progress(2);
  await tool(
    'run_command',
    { command: 'npm run build' },
    '构建阶段：固定演示输出，没有执行真实命令。',
  );
  if (ctx.run.abort) return stopped();

  let evidence: string | null = null;
  if (scenario === 'failure') {
    await tool(
      'verify_project',
      { revision: sourceRevision(currentFiles(ctx.chatId)) },
      '构建失败，还没有产生通过证据。',
      true,
    );
    if (ctx.run.abort) return stopped();
    finalize(ctx, 'failed', '检查失败：示例里缺少一个依赖。当前源码已保留，请修复后重试。');
    return;
  }

  if (scenario === 'repair') {
    const path =
      Object.keys(currentFiles(ctx.chatId)).find((name) => name.endsWith('.tsx')) ?? firstPath;
    const original = currentFiles(ctx.chatId)[path] ?? '';
    setFiles(ctx, { ...currentFiles(ctx.chatId), [path]: `${original}\n// missing import` });
    await tool(
      'verify_project',
      { revision: sourceRevision(currentFiles(ctx.chatId)) },
      '检查失败：组件缺少导入，回到主流程修复。',
      true,
    );
    await tool('edit_file', { path }, '已修复导入，旧的检查结果失效', false, () =>
      setFiles(ctx, { ...currentFiles(ctx.chatId), [path]: original }),
    );
  }
  if (ctx.run.abort) return stopped();

  const verify = async () => {
    const revision = sourceRevision(currentFiles(ctx.chatId));
    const passed = await tool(
      'verify_project',
      { revision, checks: ['type-check', 'build', 'preview-ready'] },
      `检查通过，证据绑定 ${revision}。这一步是固定演示输出，不代表真实编译。`,
    );
    if (passed) evidence = revision;
    return passed;
  };
  if (!(await verify())) return stopped();

  if (scenario === 'evidence' && !ctx.run.abort) {
    const path = 'evidence.txt';
    await tool('write_file', { path }, '检查之后又改了文件，原证据过期', false, () =>
      setFiles(ctx, { ...currentFiles(ctx.chatId), [path]: 'changed after verification' }),
    );
    await tool(
      'complete_task',
      { revision: sourceRevision(currentFiles(ctx.chatId)), evidence },
      '拒绝完成：当前修订与证据不一致，需要重新检查。',
      true,
    );
    if (!(await verify())) return stopped();
  }
  if (ctx.run.abort) return stopped();

  const accepted = canComplete(currentFiles(ctx.chatId), evidence);
  await tool(
    'complete_task',
    { revision: sourceRevision(currentFiles(ctx.chatId)), evidence },
    accepted ? '接受本轮结果，保留版本；不触发发布。' : '证据缺失，拒绝完成。',
    !accepted,
  );
  progress(3);
  if (!accepted) {
    finalize(ctx, 'failed', '完成判定未通过：缺少当前修订的证据，工作已保留。');
    return;
  }
  finalize(
    ctx,
    'succeeded',
    `本轮完成，保留 ${Object.keys(currentFiles(ctx.chatId)).length} 个文件的源码快照。工具输出与检查是固定演示，可继续对话或查看版本差异。`,
  );
}
