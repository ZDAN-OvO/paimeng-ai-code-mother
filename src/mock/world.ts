import fs from 'node:fs';
import path from 'node:path';
import {
  type ChatBundle,
  type ChatRecord,
  type ChatSummary,
  type Deploy,
  type EnvVar,
  type FileMap,
  type Message,
  type Project,
  type ProjectsResponse,
  type PublishedResponse,
  type SiteState,
  type Skill,
  type Version,
  type WorldState,
  worldStateSchema,
} from '@/shared/api/schemas';
import { changedPaths } from '@/lib/diff';
import { nowIso } from '@/lib/time';
import { uid } from './ids';
import { finishRound, skillKey } from './flow';
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

/** 上一次进程死在生成中时，把那条消息收尾成 stopped，避免永久卡在 streaming。 */
function recoverInterrupted(world: WorldState) {
  for (const chat of world.chats) {
    const stuck = chat.messages.find(
      (message) => message.streaming || message.status === 'running',
    );
    if (!stuck) continue;
    const index = world.chats.findIndex((item) => item.id === chat.id);
    world.chats[index] = finishRound(
      chat,
      stuck.id,
      'stopped',
      '进程重启中断了本轮；已完成的改动保留在版本里，可以重试。',
      chat.versions.at(-1)?.site ?? buildSite('blank', '未命名项目', 1),
      uid('ver'),
      nowIso(),
    );
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
    activeVersionId,
    viewVersionId,
    pendingPlan,
    draft,
    archivedAt,
  } = chat;
  return {
    id,
    projectId: projectId ?? null,
    draft: draft ?? null,
    title,
    modelId,
    createdAt,
    updatedAt,
    streaming,
    archivedAt: archivedAt ?? null,
    activeVersionId,
    viewVersionId,
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

/** 归档列表：草稿与项目会话都在这里，按归档时间倒序。 */
export function listArchivedChats(): ChatSummary[] {
  return getState()
    .chats.filter((chat) => chat.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
    .map(summaryOf);
}

export function archiveChat(chatId: string): ChatSummary {
  const chat = findChat(chatId);
  if (chat.projectId && chat.streaming) throw new ApiError(409, '本轮还在生成，先停止再归档');
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

/** 草稿：还没决定变成项目的会话。 */
export function listDrafts(): ChatSummary[] {
  return getState()
    .chats.filter((chat) => !chat.projectId && !chat.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summaryOf);
}

export function listProjects(): ProjectsResponse['projects'] {
  const world = getState();
  return world.projects
    .map((project) => {
      const chats = world.chats.filter((chat) => chat.projectId === project.id);
      const versions = chats.flatMap((chat) => chat.versions);
      const latest = versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const lastChat = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return {
        ...project,
        chatCount: chats.length,
        versionCount: versions.length,
        lastChatId: lastChat?.id ?? null,
        thumb: latest?.site ?? null,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function templateVersion(
  chatId: string,
  templateId: string,
  brand: string,
  createdAt: string,
): Version {
  const site = buildSite(templateId, brand, 1);
  const files = buildSiteFiles(site);
  return {
    id: uid('ver'),
    chatId,
    messageId: null,
    seq: 1,
    label: 'v1',
    summary: `模板「${TEMPLATES.find((item) => item.id === templateId)?.name ?? templateId}」的初始版本`,
    createdAt,
    files,
    site,
    changedFiles: changedPaths({}, files),
  };
}

/** 草稿：首页一句话或模板卡先落一条会话，等用户决定要不要变成项目。 */
export function createDraft(input: {
  prompt: string;
  templateId: string;
  modelId?: string;
}): ChatSummary {
  const world = getState();
  const chatId = uid('chat');
  const createdAt = nowIso();
  const templateId = resolveTemplate(input.templateId, input.prompt);
  const chat: ChatRecord = {
    id: chatId,
    projectId: null,
    draft: { prompt: input.prompt, templateId },
    title: deriveProjectName(input.prompt),
    modelId: input.modelId || MODEL_FALLBACK,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
    archivedAt: null,
    activeVersionId: null,
    viewVersionId: null,
    pendingPlan: null,
    messages: [],
    versions: [],
  };
  if (input.templateId !== 'auto') {
    const version = templateVersion(chatId, templateId, chat.title, createdAt);
    chat.versions = [version];
    chat.activeVersionId = version.id;
    chat.viewVersionId = version.id;
  }
  world.chats = [chat, ...world.chats];
  touch();
  return summaryOf(chat);
}

/** 草稿转项目：建 Project 并把这条会话接管过去，不部署。 */
export function promoteChat(chatId: string): { project: Project; chat: ChatSummary } {
  const chat = findChat(chatId);
  if (chat.projectId) throw new ApiError(409, '这个对话已经是项目的一部分');
  const createdAt = nowIso();
  const project: Project = {
    id: uid('proj'),
    name: chat.title,
    prompt: chat.draft?.prompt ?? chat.title,
    templateId: chat.draft?.templateId ?? 'auto',
    createdAt,
    updatedAt: createdAt,
    env: [],
    deployKey: null,
    deploys: [],
  };
  getState().projects = [project, ...getState().projects];
  const next = updateChat(chatId, (current) => ({
    ...current,
    projectId: project.id,
    draft: null,
    updatedAt: createdAt,
  }));
  touch();
  return { project, chat: summaryOf(next) };
}

export function createProject(input: { prompt: string; templateId: string; modelId?: string }): {
  project: Project;
  chat: ChatRecord;
} {
  const world = getState();
  const projectId = uid('proj');
  const chatId = uid('chat');
  const name = deriveProjectName(input.prompt);
  const templateId = resolveTemplate(input.templateId, input.prompt);
  const createdAt = nowIso();
  const project: Project = {
    id: projectId,
    name,
    prompt: input.prompt,
    templateId,
    createdAt,
    updatedAt: createdAt,
    env: [],
    deployKey: null,
    deploys: [],
  };
  const chat: ChatRecord = {
    id: chatId,
    projectId,
    draft: null,
    title: name,
    modelId: input.modelId || MODEL_FALLBACK,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
    archivedAt: null,
    activeVersionId: null,
    viewVersionId: null,
    pendingPlan: null,
    messages: [],
    versions: [],
  };
  // 明确选了模板：先把模板产物落成 v1，用户进对话页时右栏就有东西可看。
  if (input.templateId !== 'auto') {
    const version = templateVersion(chatId, templateId, name, createdAt);
    chat.versions = [version];
    chat.activeVersionId = version.id;
    chat.viewVersionId = version.id;
  }

  world.projects = [project, ...world.projects];
  world.chats = [chat, ...world.chats];
  touch();
  return { project, chat };
}

export function renameProject(projectId: string, name: string): Project {
  return updateProject(projectId, (project) => ({ ...project, name, updatedAt: nowIso() }));
}

export function deleteProject(projectId: string) {
  findProject(projectId);
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
  const latest = siblings
    .flatMap((chat) => chat.versions)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const chatId = uid('chat');
  const createdAt = nowIso();
  const baseline: Version | null = latest
    ? {
        id: uid('ver'),
        seq: 1,
        chatId,
        messageId: null,
        label: 'v1 · 起点',
        summary: '新对话从项目当前源码树开始，历史消息不会带过来。',
        createdAt,
        files: latest.files,
        site: latest.site,
        changedFiles: [],
      }
    : null;
  const chat: ChatRecord = {
    id: chatId,
    projectId,
    draft: null,
    title: input.title?.trim() || `${project.name} · 新对话`,
    modelId: input.modelId || siblings[0]?.modelId || MODEL_FALLBACK,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
    archivedAt: null,
    pendingPlan: null,
    messages: [],
    versions: baseline ? [baseline] : [],
    activeVersionId: baseline?.id ?? null,
    viewVersionId: baseline?.id ?? null,
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
  const project = chat.projectId ? findProject(chat.projectId) : null;
  return {
    project,
    chat: summaryOf(chat),
    chats: chat.projectId ? findChatByProject(chat.projectId).map(summaryOf) : [],
    messages: chat.messages,
    versions: chat.versions,
    skills: getState().skills,
    models: MODELS,
  };
}

export function listVersions(chatId: string): Version[] {
  return findChat(chatId).versions;
}

export function findVersion(chatId: string, versionId: string): Version {
  const version = findChat(chatId).versions.find((item) => item.id === versionId);
  if (!version) throw new ApiError(404, `找不到版本 ${versionId}`);
  return version;
}

export function versionFiles(chatId: string, versionId: string) {
  const version = findVersion(chatId, versionId);
  return { versionId, files: version.files, site: version.site };
}

export function versionDiff(chatId: string, versionId: string) {
  const chat = findChat(chatId);
  const index = chat.versions.findIndex((item) => item.id === versionId);
  if (index < 0) throw new ApiError(404, `找不到版本 ${versionId}`);
  const after = chat.versions[index];
  const before = index > 0 ? chat.versions[index - 1] : null;
  const files = changedPaths(before?.files ?? {}, after.files).map((filePath) => {
    const beforeText = before?.files[filePath] ?? '';
    const afterText = after.files[filePath] ?? '';
    const beforeLines = beforeText ? beforeText.split('\n') : [];
    const afterLines = afterText ? afterText.split('\n') : [];
    return {
      path: filePath,
      status: beforeText && afterText ? 'modified' : afterText ? 'added' : 'removed',
      added: Math.max(0, afterLines.length - beforeLines.length) || afterLines.length,
      removed: Math.max(0, beforeLines.length - afterLines.length),
      before: beforeText,
      after: afterText,
    } as const;
  });
  return { versionId, files };
}

export function previewOf(chatId: string) {
  const chat = findChat(chatId);
  const version = chat.viewVersionId
    ? chat.versions.find((item) => item.id === chat.viewVersionId)
    : chat.versions.at(-1);
  return {
    chatId,
    versionId: version?.id ?? null,
    site: chat.liveSite ?? version?.site ?? null,
  };
}

export function rollbackTo(chatId: string, versionId: string): Version {
  const chat = findChat(chatId);
  if (chat.streaming || chat.pendingPlan) throw new ApiError(409, '本轮还没结束，先停止再回滚');
  const target = chat.versions.find((item) => item.id === versionId);
  if (!target) throw new ApiError(404, `找不到版本 ${versionId}`);
  const active = chat.versions.at(-1);
  const seq = chat.versions.length + 1;
  const newId = uid('ver');
  const createdAt = nowIso();
  const version: Version = {
    id: newId,
    seq,
    chatId,
    messageId: uid('msg'),
    label: `v${seq} · 回滚到 v${target.seq}`,
    summary: `工作区已恢复成 v${target.seq} 的源码树，并追加为 v${seq}。历史保持线性，随时可以再滚回来。`,
    createdAt,
    files: target.files,
    site: target.site,
    changedFiles: changedPaths(active?.files ?? {}, target.files),
    restoredFrom: target.seq,
  };
  updateChat(chatId, (current) => ({
    ...current,
    updatedAt: createdAt,
    versions: [...current.versions, version],
    activeVersionId: newId,
    viewVersionId: newId,
    messages: [
      ...current.messages,
      {
        id: version.messageId as string,
        role: 'assistant',
        parts: [
          {
            id: uid('part'),
            type: 'text',
            text: `已把工作区回滚到 v${target.seq}，并追加为新版本 v${seq}。预览已经切到旧源码树，改过的文件也可以在 diff 里对比。`,
          },
        ],
        createdAt,
        finishedAt: createdAt,
        versionId: newId,
        status: 'succeeded',
      },
    ],
  }));
  return version;
}

export function recordDeploy(projectId: string, versionId: string): Deploy {
  const project = findProject(projectId);
  const version = getState()
    .chats.filter((chat) => chat.projectId === projectId)
    .flatMap((chat) => chat.versions)
    .find((item) => item.id === versionId);
  if (!version) throw new ApiError(404, `找不到版本 ${versionId}`);
  const deployKey = project.deployKey ?? uid('site').replace('_', '-');
  const deploy: Deploy = {
    id: uid('deploy'),
    deployKey,
    versionId,
    versionSeq: version.seq,
    state: 'building',
    createdAt: nowIso(),
  };
  updateProject(projectId, (current) => ({
    ...current,
    deployKey,
    deploys: [deploy, ...current.deploys.filter((item) => item.versionId !== versionId)],
    updatedAt: nowIso(),
  }));
  return deploy;
}

export function finishDeploy(deployId: string, state: 'ready' | 'failed') {
  const world = getState();
  for (const project of world.projects) {
    const index = project.deploys.findIndex((item) => item.id === deployId);
    if (index < 0) continue;
    project.deploys[index] = { ...project.deploys[index], state };
    touch();
    return project.deploys[index];
  }
  throw new ApiError(404, `找不到发布 ${deployId}`);
}

export function listDeploys(projectId: string): Deploy[] {
  return findProject(projectId).deploys;
}

export function publishedByKey(deployKey: string): PublishedResponse {
  const world = getState();
  const project = world.projects.find((item) => item.deployKey === deployKey);
  const deploy = project?.deploys.find((item) => item.deployKey === deployKey);
  if (!project || !deploy) throw new ApiError(404, '这个发布地址没有可访问的版本');
  const version = world.chats
    .flatMap((chat) => chat.versions)
    .find((item) => item.id === deploy.versionId);
  if (!version) throw new ApiError(404, '这个发布地址没有可访问的版本');
  return { project, deploy, version };
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
  const slug = input.slug?.trim() || manifest.content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ApiError(400, 'slug 仅使用小写字母、数字和单个连字符');
  }
  const existing = getState().skills.find((item) => item.source === 'user' && item.slug === slug);
  if (existing) throw new ApiError(409, `用户技能里已存在 ${slug}`);
  const description =
    input.description?.trim() ||
    manifest.content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ||
    slug;
  const skill: Skill = {
    slug,
    name: slug,
    description,
    source: 'user',
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
  return buildSite(resolveTemplate(project.templateId, project.prompt), project.name, iteration);
}

/** 草稿还没有项目，站点按草稿自己的描述与模板生成。 */
export function siteForChat(chat: ChatRecord, iteration: number): SiteState {
  if (chat.projectId) return siteForProject(findProject(chat.projectId), iteration);
  const prompt = chat.draft?.prompt ?? chat.title;
  return buildSite(
    resolveTemplate(chat.draft?.templateId ?? 'auto', prompt),
    chat.title,
    iteration,
  );
}

export function filesOf(chat: ChatRecord): FileMap {
  return chat.liveFiles ?? chat.versions.at(-1)?.files ?? {};
}
