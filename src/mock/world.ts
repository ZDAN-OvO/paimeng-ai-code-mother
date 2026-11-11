import fs from 'node:fs';
import path from 'node:path';
import {
  type ChatBundle,
  type ChangeSet,
  type ChatRecord,
  type ChatSummary,
  type EnvVar,
  type FileMap,
  type Message,
  type Project,
  type ProjectsResponse,
  type RunStatus,
  type Runtime,
  type SiteState,
  type Skill,
  type WorldState,
  worldStateSchema,
} from '@/shared/api/schemas';
import { changedPaths } from '@/lib/diff';
import { undoChangeSet as undoFiles } from '@/lib/change-set';
import { nowIso } from '@/lib/time';
import { parseSkillManifest } from '@/server/skills/manifest';
import { uid } from './ids';
import { finishRound, skillKey, type WorkspaceSnapshot } from './flow';
import { buildSite, deriveProjectName, resolveTemplate } from './site';
import { buildSiteFiles } from './seed/files';
import { TEMPLATES } from './seed/templates';
import { seedProjects } from './seed/projects';
import { MODELS, MODEL_FALLBACK } from './seed/models';

/** 带状态码的失败，route handler 直接转成对应的 JSON 错误。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATE_DIR = path.join(process.cwd(), 'data', 'mock');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * Next 把每个 route 打成独立 bundle，模块级变量会在各 bundle 里各存一份。
 * mock 世界必须跨 route 共享，所以挂在 globalThis 上；这也让 HMR 不会丢状态。
 */
type Holder = { state: WorldState | null; timer: NodeJS.Timeout | null };

const holder: Holder = ((globalThis as { __paimengMockWorld?: Holder }).__paimengMockWorld ??= {
  state: null,
  timer: null,
});

function seed(): WorldState {
  const { projects, chats, skills } = seedProjects();
  return { version: 1, projects, chats, skills };
}

export function sampleRuntime(): Runtime {
  return { state: 'stopped', port: null, url: null, logs: [], source: 'sample' };
}

/** 没有持久化回合起点的旧数据：只能收尾消息，无法生成撤销记录。 */
function markInterrupted(chat: ChatRecord, messageId: string, now: string): ChatRecord {
  return {
    ...chat,
    streaming: false,
    updatedAt: now,
    activeRound: null,
    messages: chat.messages.map((message) =>
      message.id !== messageId
        ? message
        : {
            ...message,
            streaming: false,
            status: 'stopped',
            completionReviewed: false,
            finishedAt: now,
            parts: message.parts.map((part) =>
              part.type === 'tool' && part.state === 'running'
                ? {
                    ...part,
                    state: 'error',
                    output: '进程重启中断了本轮；已写入的项目文件保留。',
                  }
                : part.type === 'review' && part.state === 'running'
                  ? {
                      ...part,
                      state: 'error',
                      findings: ['进程重启中断了本轮，审查没有给出结论。'],
                    }
                  : part,
            ),
          },
    ),
  };
}

/**
 * 上一次进程死在生成中时收尾：有持久化的回合起点，就用它和当前项目快照生成一条
 * stopped 的改动记录（可 diff、可撤销）；没有改动或没有起点时只把消息收尾。
 * 不自动续跑。
 */
function recoverInterrupted(world: WorldState) {
  const now = nowIso();
  for (let index = 0; index < world.chats.length; index += 1) {
    const chat = world.chats[index];
    const stuck = chat.messages.find(
      (message) => message.streaming || message.status === 'running',
    );
    if (!stuck) {
      if (chat.activeRound) world.chats[index] = { ...chat, activeRound: null };
      continue;
    }
    const projectIndex = world.projects.findIndex((item) => item.id === chat.projectId);
    const project = projectIndex >= 0 ? world.projects[projectIndex] : null;
    const start = chat.activeRound;
    if (project && start && start.messageId === stuck.id && !stuck.changeSetId) {
      const after: WorkspaceSnapshot = { files: project.files, site: project.site };
      const { chat: nextChat, changeSet } = finishRound(
        chat,
        stuck.id,
        'stopped',
        '进程重启中断了本轮；已写入的项目文件保留，可以在改动记录里撤销。',
        start.before,
        after,
        {
          changeSetId: uid('cs'),
          seq: project.changeSets.length + 1,
          now,
          reviewed: false,
        },
      );
      world.chats[index] = { ...nextChat, activeRound: null };
      if (changeSet) {
        world.projects[projectIndex] = {
          ...project,
          changeSets: [...project.changeSets, changeSet],
          updatedAt: now,
        };
      }
    } else {
      world.chats[index] = markInterrupted(chat, stuck.id, now);
    }
  }
}

export function getState(): WorldState {
  if (holder.state) return holder.state;
  let loaded: WorldState | null = null;
  try {
    if (fs.existsSync(STATE_FILE)) {
      loaded = worldStateSchema.parse(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (error) {
    console.warn(`[mock] 忽略损坏的状态文件 ${STATE_FILE}：${(error as Error).message}`);
  }
  holder.state = loaded ?? seed();
  recoverInterrupted(holder.state);
  persistSoon();
  return holder.state;
}

export function persistSoon() {
  if (holder.timer) clearTimeout(holder.timer);
  holder.timer = setTimeout(() => {
    holder.timer = null;
    flush();
  }, 300);
  holder.timer.unref?.();
}

/** 立即落盘：先写临时文件再 rename，避免写一半被读到。 */
export function flush() {
  const world = holder.state;
  if (!world) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(world));
    fs.renameSync(temp, STATE_FILE);
  } catch (error) {
    console.warn(`[mock] 状态落盘失败：${(error as Error).message}`);
  }
}

function touch() {
  persistSoon();
}

export function appendUserMessage(chatId: string, text: string) {
  updateChat(chatId, (chat) => ({
    ...chat,
    updatedAt: nowIso(),
    messages: [
      ...chat.messages,
      {
        id: uid('msg'),
        role: 'user',
        parts: [{ id: uid('part'), type: 'text', text }],
        createdAt: nowIso(),
      },
    ],
  }));
}

export function summaryOf(chat: ChatRecord): ChatSummary {
  const {
    id,
    projectId,
    title,
    modelId,
    createdAt,
    updatedAt,
    streaming,
    archivedAt,
    pendingPlan,
  } = chat;
  return {
    id,
    projectId,
    title,
    modelId,
    createdAt,
    updatedAt,
    streaming,
    archivedAt: archivedAt ?? null,
    pendingPlan: pendingPlan ?? null,
  };
}

export function findProject(projectId: string): Project {
  const project = getState().projects.find((item) => item.id === projectId);
  if (!project) throw new ApiError(404, `找不到项目 ${projectId}`);
  return project;
}

export function findChat(chatId: string): ChatRecord {
  const chat = getState().chats.find((item) => item.id === chatId);
  if (!chat) throw new ApiError(404, `找不到对话 ${chatId}`);
  return chat;
}

export function updateChat(chatId: string, update: (chat: ChatRecord) => ChatRecord): ChatRecord {
  const world = getState();
  const index = world.chats.findIndex((item) => item.id === chatId);
  if (index < 0) throw new ApiError(404, `找不到对话 ${chatId}`);
  const next = update(world.chats[index]);
  world.chats[index] = next;
  touch();
  return next;
}

export function updateMessage(
  chatId: string,
  messageId: string,
  update: (message: Message) => Message,
): ChatRecord {
  return updateChat(chatId, (chat) => ({
    ...chat,
    messages: chat.messages.map((message) =>
      message.id === messageId ? update(message) : message,
    ),
  }));
}

export function updateProject(projectId: string, update: (project: Project) => Project): Project {
  const world = getState();
  const index = world.projects.findIndex((item) => item.id === projectId);
  if (index < 0) throw new ApiError(404, `找不到项目 ${projectId}`);
  const next = update(world.projects[index]);
  world.projects[index] = next;
  touch();
  return next;
}

export function findChatByProject(projectId: string): ChatRecord[] {
  return getState()
    .chats.filter((chat) => chat.projectId === projectId && !chat.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 项目里是否有正在生成或等审批的回合；共享文件下这些状态会挡住写文件的操作。 */
function busyChat(projectId: string, kind: 'streaming' | 'pendingPlan', ignoreChatId?: string) {
  return getState().chats.find(
    (chat) => chat.projectId === projectId && chat.id !== ignoreChatId && chat[kind],
  );
}

/** 同一项目的文件是共享的：别的对话在生成时不能开始新一轮，也不能撤销。 */
export function assertProjectCanRun(projectId: string, ignoreChatId?: string) {
  findProject(projectId);
  const streaming = busyChat(projectId, 'streaming', ignoreChatId);
  if (streaming) {
    throw new ApiError(
      409,
      `项目里还有一轮正在生成（${streaming.title}），等它结束或先停止，再继续。`,
    );
  }
  const waiting = busyChat(projectId, 'pendingPlan', ignoreChatId);
  if (waiting) {
    throw new ApiError(409, `项目里有对话正在等方案审批（${waiting.title}），先处理它再继续。`);
  }
}

/** 撤销与删除会整体改写项目文件，只在项目完全空闲时允许。 */
export function assertProjectIdle(projectId: string, action: string) {
  findProject(projectId);
  const streaming = busyChat(projectId, 'streaming');
  if (streaming) {
    throw new ApiError(
      409,
      `项目里还有一轮正在生成（${streaming.title}），先停止或等它结束再${action}。`,
    );
  }
}

/** 归档列表：按归档时间倒序。 */
export function listArchivedChats(): ChatSummary[] {
  return getState()
    .chats.filter((chat) => chat.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
    .map(summaryOf);
}

export function archiveChat(chatId: string): ChatSummary {
  const chat = findChat(chatId);
  if (chat.streaming) throw new ApiError(409, '本轮还在生成，先停止再归档');
  const next = updateChat(chatId, (current) => ({
    ...current,
    archivedAt: current.archivedAt ?? nowIso(),
    updatedAt: nowIso(),
  }));
  return summaryOf(next);
}

export function restoreChat(chatId: string): ChatSummary {
  const next = updateChat(chatId, (current) => ({
    ...current,
    archivedAt: null,
    updatedAt: nowIso(),
  }));
  return summaryOf(next);
}

export function listProjects(): ProjectsResponse['projects'] {
  const world = getState();
  return world.projects
    .map((project) => {
      const chats = world.chats.filter((chat) => chat.projectId === project.id);
      const lastChat = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        templateId: project.templateId,
        workspacePath: project.workspacePath,
        workspaceState: project.workspaceState,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        chatCount: chats.length,
        changeCount: project.changeSets.length,
        lastChatId: lastChat?.id ?? null,
        thumb: project.site,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function baseNameOf(workspacePath: string): string {
  const parts = workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || '未命名项目';
}

/** 新建项目：路径只做记录；首版不会真的创建目录，界面会标成示例项目。 */
export function createProject(input: {
  workspacePath: string;
  name?: string;
  prompt: string;
  templateId: string;
  modelId?: string;
}): { project: Project; chat: ChatRecord } {
  const world = getState();
  const now = nowIso();
  const chatId = uid('chat');
  const name =
    input.name?.trim() ||
    (input.prompt ? deriveProjectName(input.prompt) : '') ||
    baseNameOf(input.workspacePath);
  // 没明确选模板时保留 auto：模板入口只在用户真的选了模板时出现。
  const templateId =
    input.templateId === 'auto' ? 'auto' : resolveTemplate(input.templateId, input.prompt || name);

  const project: Project = {
    id: uid('proj'),
    name,
    description: input.prompt || input.workspacePath,
    templateId,
    createdAt: now,
    updatedAt: now,
    env: [],
    workspacePath: input.workspacePath,
    workspaceState: 'sample',
    files: {},
    site: null,
    changeSets: [],
    runtime: sampleRuntime(),
  };

  const chat: ChatRecord = {
    id: chatId,
    projectId: project.id,
    title: name,
    modelId: input.modelId || MODEL_FALLBACK,
    createdAt: now,
    updatedAt: now,
    streaming: false,
    archivedAt: null,
    pendingPlan: null,
    messages: [],
  };

  // 明确选了模板：先把模板产物落成一条改动记录，进对话页右栏就有东西可看。
  if (input.templateId !== 'auto') {
    const site = buildSite(templateId, name, 1);
    const files = buildSiteFiles(site);
    const templateName = TEMPLATES.find((item) => item.id === templateId)?.name ?? templateId;
    project.files = files;
    project.site = site;
    project.changeSets = [
      {
        id: uid('cs'),
        seq: 1,
        chatId,
        messageId: null,
        summary: `模板「${templateName}」的初始文件`,
        createdAt: now,
        status: 'applied',
        changedFiles: changedPaths({}, files),
        before: {},
        after: files,
        siteBefore: null,
        siteAfter: site,
      },
    ];
  }

  world.projects = [project, ...world.projects];
  world.chats = [chat, ...world.chats];
  touch();
  return { project, chat };
}

/** 打开已有目录：真实读写本地目录不在这一版的范围，明确拒绝而不是假装连上。 */
export function openProject(): never {
  throw new ApiError(501, '尚不能打开本地目录；可以先体验示例项目。');
}

export function renameProject(projectId: string, name: string): Project {
  return updateProject(projectId, (project) => ({ ...project, name, updatedAt: nowIso() }));
}

export function deleteProject(projectId: string) {
  assertProjectIdle(projectId, '删除项目');
  const world = getState();
  world.projects = world.projects.filter((item) => item.id !== projectId);
  world.chats = world.chats.filter((chat) => chat.projectId !== projectId);
  touch();
}

export function setProjectEnv(projectId: string, env: EnvVar[]): Project {
  const cleaned = env.filter((item) => item.key.trim().length > 0);
  return updateProject(projectId, (project) => ({ ...project, env: cleaned, updatedAt: nowIso() }));
}

export function createChat(
  projectId: string,
  input: { modelId?: string; title?: string },
): ChatSummary {
  const project = findProject(projectId);
  const siblings = findChatByProject(projectId);
  const now = nowIso();
  const chat: ChatRecord = {
    id: uid('chat'),
    projectId,
    title: input.title?.trim() || `${project.name} · 新对话`,
    modelId: input.modelId || siblings[0]?.modelId || MODEL_FALLBACK,
    createdAt: now,
    updatedAt: now,
    streaming: false,
    archivedAt: null,
    pendingPlan: null,
    messages: [],
  };
  const world = getState();
  world.chats = [chat, ...world.chats];
  touch();
  return summaryOf(chat);
}

export function patchChat(
  chatId: string,
  input: { modelId?: string; title?: string },
): ChatSummary {
  const chat = updateChat(chatId, (current) => ({
    ...current,
    modelId: input.modelId ?? current.modelId,
    title: input.title?.trim() || current.title,
    updatedAt: nowIso(),
  }));
  return summaryOf(chat);
}

export function getBundle(chatId: string): ChatBundle {
  const chat = findChat(chatId);
  return {
    project: findProject(chat.projectId),
    chat: summaryOf(chat),
    chats: findChatByProject(chat.projectId).map(summaryOf),
    messages: chat.messages,
    skills: getState().skills,
    models: MODELS,
  };
}

/** 当前项目文件：撤销与 diff 都以它为磁盘真相。 */
export function filesOf(project: Project): FileMap {
  return project.files;
}

/**
 * 一轮结束时收尾：收尾消息、把项目文件的变化记成一条改动记录。
 * before/after 由调用方在回合开始与结束时捕获；没有动文件的轮次不产生记录。
 */
export function commitRound(
  chatId: string,
  input: {
    messageId: string;
    status: RunStatus;
    summary: string;
    before: WorkspaceSnapshot;
    after: WorkspaceSnapshot;
    reviewed?: boolean;
  },
): { chat: ChatRecord; changeSet: ChangeSet | null } {
  const chat = findChat(chatId);
  const project = findProject(chat.projectId);
  const now = nowIso();
  const { chat: nextChat, changeSet } = finishRound(
    chat,
    input.messageId,
    input.status,
    input.summary,
    input.before,
    input.after,
    {
      changeSetId: uid('cs'),
      seq: project.changeSets.length + 1,
      now,
      reviewed: input.reviewed,
    },
  );
  if (changeSet) {
    updateProject(project.id, (current) => ({
      ...current,
      files: input.after.files,
      site: input.after.site,
      changeSets: [...current.changeSets, changeSet],
      updatedAt: now,
    }));
  }
  // 回合结束（无论成功、失败还是中断）都不再保留起点。
  const settled: ChatRecord = { ...nextChat, activeRound: null };
  updateChat(chatId, () => settled);
  return { chat: settled, changeSet };
}

/**
 * 撤销一条改动记录：写回 before 文件与预览。
 * 这一轮之后任何文件又被改过（后续对话或外部编辑器）都拒绝，不盲覆盖。
 */
export function undoChangeSet(
  projectId: string,
  changeSetId: string,
): { project: Project; changeSet: ChangeSet } {
  assertProjectIdle(projectId, '撤销改动');
  const project = findProject(projectId);
  const changeSet = project.changeSets.find((item) => item.id === changeSetId);
  if (!changeSet) throw new ApiError(404, `找不到改动记录 ${changeSetId}`);
  const outcome = undoFiles(project.files, changeSet);
  if (!outcome.ok) {
    if (outcome.reason === 'already-undone') throw new ApiError(409, '这条改动已经撤销过了');
    throw new ApiError(
      409,
      `这些文件在这一轮之后又被改过，撤销会覆盖它们：${outcome.conflicts.join('、')}。请先处理这些文件。`,
    );
  }
  const nextChangeSet: ChangeSet = { ...changeSet, status: 'undone' };
  const next = updateProject(projectId, (current) => ({
    ...current,
    files: outcome.files,
    site: changeSet.siteBefore,
    changeSets: current.changeSets.map((item) => (item.id === changeSetId ? nextChangeSet : item)),
    updatedAt: nowIso(),
  }));
  return { project: next, changeSet: nextChangeSet };
}

export function listSkills(): Skill[] {
  return getState().skills;
}

function findSkill(slug: string): Skill {
  const skill = getState().skills.find((item) => skillKey(item) === slug);
  if (!skill) throw new ApiError(404, `找不到技能 ${slug}`);
  return skill;
}

export function patchSkill(slug: string, patch: { enabled?: boolean; trusted?: boolean }): Skill {
  const skill = findSkill(slug);
  const trusted = patch.trusted ?? skill.trusted;
  const enabled = patch.trusted === false ? false : (patch.enabled ?? skill.enabled);
  return updateSkill(slug, { ...skill, trusted, enabled });
}

function updateSkill(slug: string, next: Skill): Skill {
  const world = getState();
  const index = world.skills.findIndex((item) => skillKey(item) === slug);
  if (index < 0) throw new ApiError(404, `找不到技能 ${slug}`);
  world.skills[index] = next;
  touch();
  return next;
}

export function importSkill(input: {
  files: { path: string; content: string }[];
  trusted: boolean;
  slug?: string;
  description?: string;
}): Skill {
  const manifest = input.files.find((file) => file.path === 'SKILL.md');
  if (!manifest) throw new ApiError(400, '导入的技能必须包含根目录 SKILL.md');
  let metadata: ReturnType<typeof parseSkillManifest>;
  try {
    metadata = parseSkillManifest(manifest.content, input.slug?.trim());
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : '技能元信息不合法');
  }
  const slug = input.slug?.trim() || metadata.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ApiError(400, 'slug 仅使用小写字母、数字和单个连字符');
  }
  const existing = getState().skills.find((item) => item.source === 'user' && item.slug === slug);
  if (existing) throw new ApiError(409, `用户技能里已存在 ${slug}`);
  const description = input.description?.trim() || metadata.description;
  const skill: Skill = {
    slug,
    name: slug,
    description,
    source: 'user',
    disableModelInvocation: metadata.disableModelInvocation,
    trusted: input.trusted,
    enabled: input.trusted,
    files: input.files.map((file) => file.path),
    contents: Object.fromEntries(input.files.map((file) => [file.path, file.content])),
  };
  getState().skills = [...getState().skills, skill];
  touch();
  return skill;
}

export function deleteSkill(slug: string) {
  const skill = findSkill(slug);
  if (skill.source === 'builtin') throw new ApiError(403, '内置技能只读');
  const world = getState();
  world.skills = world.skills.filter((item) => skillKey(item) !== slug);
  touch();
}

export function findModel(modelId: string | undefined) {
  return MODELS.find((item) => item.id === modelId) ?? MODELS[0];
}

/* ------------------------------------------------------------------ 工具 */

export function siteForProject(project: Project, iteration: number): SiteState {
  return buildSite(
    resolveTemplate(project.templateId, project.description),
    project.name,
    iteration,
  );
}

export function snapshotOf(project: Project): WorkspaceSnapshot {
  return { files: project.files, site: project.site };
}
