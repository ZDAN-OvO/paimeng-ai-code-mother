import { mkdir, rm, stat } from 'node:fs/promises';
import { sqlite } from '@/server/db';
import { newId } from '@/server/id';
import {
  chatSummarySchema,
  type ChatBundle,
  type ChatSummary,
  type FileIndex,
  type Message,
  type Model,
  type Project,
  type ProjectSummary,
} from '@/shared/api/schemas';
import { discoverSkills } from '@/server/skills/catalog';
import { commandOutputDir, projectDataDir } from '@/server/storage';
import { ApiError } from '@/server/http';
import { listProjectFiles, validateWorkspacePath, WorkspaceError } from './workspace';

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  template_id: string;
  workspace_path: string;
  file_index: string | null;
  created_at: number;
  updated_at: number;
};

type ChatRow = {
  id: string;
  project_id: string;
  title: string;
  model_id: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type MessageRow = {
  id: string;
  chat_id: string;
  seq: number;
  role: Message['role'];
  parts: string;
  status: Message['status'] | null;
  stop_reason: Message['stopReason'] | null;
  error: string | null;
  change_set_id: string | null;
  run_id: string | null;
  created_at: number;
  finished_at: number | null;
};

export class ProjectError extends ApiError {}

function iso(value: number | null | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

export function configuredModels(): Model[] {
  const modelId = process.env.AI_MODEL?.trim();
  const baseUrl = process.env.AI_BASE_URL?.trim();
  if (!modelId) return [];
  let provider = 'OpenAI 兼容';
  try {
    provider = baseUrl ? new URL(baseUrl).host : provider;
  } catch {
    provider = baseUrl || provider;
  }
  return [{ id: modelId, name: modelId, provider, configured: Boolean(baseUrl) }];
}

function defaultModelId() {
  return configuredModels().find((model) => model.configured)?.id ?? '';
}

export async function indexedFiles(projectId: string, root: string): Promise<FileIndex> {
  const { paths, truncated } = await listProjectFiles(root, 5000);
  const index: FileIndex = {
    paths,
    truncated,
    limit: 5000,
    indexedAt: new Date().toISOString(),
  };
  sqlite()
    .prepare('update project set file_index = ? where id = ?')
    .run(JSON.stringify(index), projectId);
  return index;
}

async function ensureWorkspace(row: ProjectRow) {
  try {
    const info = await stat(row.workspace_path);
    if (!info.isDirectory()) throw new ProjectError(409, '项目目录已不是目录，请重新打开');
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ProjectError(409, '项目目录已不存在，请重新打开');
    if (code === 'EACCES') throw new ProjectError(403, '没有权限访问项目目录');
    throw error;
  }
}

export async function projectFromRow(row: ProjectRow): Promise<Project> {
  await ensureWorkspace(row);
  let index: FileIndex;
  if (row.file_index) {
    try {
      index = JSON.parse(row.file_index) as FileIndex;
    } catch {
      index = await indexedFiles(row.id, row.workspace_path);
    }
  } else {
    index = await indexedFiles(row.id, row.workspace_path);
  }
  const counts = sqlite()
    .prepare(
      `select
        (select count(*) from chat where project_id = ?) as chats,
        (select count(*) from change_set where project_id = ?) as changes`,
    )
    .get(row.id, row.id) as { chats: number; changes: number };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    templateId: row.template_id,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    workspacePath: row.workspace_path,
    fileIndex: index,
    chatCount: counts.chats,
    changeCount: counts.changes,
  };
}

export function getProjectRow(projectId: string) {
  return sqlite().prepare('select * from project where id = ?').get(projectId) as
    ProjectRow | undefined;
}

export async function getProject(projectId: string) {
  const row = getProjectRow(projectId);
  if (!row) throw new ProjectError(404, '项目不存在');
  return projectFromRow(row);
}

export async function projectRoot(projectId: string) {
  const row = getProjectRow(projectId);
  if (!row) throw new ProjectError(404, '项目不存在');
  await ensureWorkspace(row);
  return row.workspace_path;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = sqlite()
    .prepare('select * from project order by updated_at desc')
    .all() as ProjectRow[];
  return rows.map((row) => {
    const counts = sqlite()
      .prepare(
        `select
          (select count(*) from chat where project_id = ?) as chats,
          (select count(*) from change_set where project_id = ?) as changes,
          (select id from chat where project_id = ? order by updated_at desc limit 1) as last_chat`,
      )
      .get(row.id, row.id, row.id) as { chats: number; changes: number; last_chat: string | null };
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      templateId: row.template_id,
      workspacePath: row.workspace_path,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      chatCount: counts.chats,
      changeCount: counts.changes,
      lastChatId: counts.last_chat,
    };
  });
}

function chatRow(chatId: string) {
  return sqlite().prepare('select * from chat where id = ?').get(chatId) as ChatRow | undefined;
}

function activeRun(chatId: string) {
  return sqlite()
    .prepare(
      "select id, status from agent_run where chat_id = ? and status in ('running','awaiting_approval') order by started_at desc limit 1",
    )
    .get(chatId) as { id: string; status: string } | undefined;
}

export function toChatSummary(row: ChatRow): ChatSummary {
  const active = activeRun(row.id);
  return chatSummarySchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    modelId: row.model_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    streaming: active?.status === 'running',
    pendingApproval: active?.status === 'awaiting_approval',
    archivedAt: iso(row.archived_at) ?? null,
  });
}

export function getChatRow(chatId: string) {
  const row = chatRow(chatId);
  if (!row) throw new ProjectError(404, '对话不存在');
  return row;
}

export function listChats(projectId: string, archived = false): ChatSummary[] {
  const rows = sqlite()
    .prepare(
      archived
        ? 'select * from chat where project_id = ? and archived_at is not null order by updated_at desc'
        : 'select * from chat where project_id = ? and archived_at is null order by updated_at desc',
    )
    .all(projectId) as ChatRow[];
  return rows.map(toChatSummary);
}

export function listArchivedChats(): ChatSummary[] {
  const rows = sqlite()
    .prepare('select * from chat where archived_at is not null order by updated_at desc')
    .all() as ChatRow[];
  return rows.map(toChatSummary);
}

function titleForProject(name: string) {
  return name.length > 24 ? `${name.slice(0, 24)}…` : `${name} · 开发`;
}

export function createChat(projectId: string, input: { title?: string; modelId?: string } = {}) {
  const project = getProjectRow(projectId);
  if (!project) throw new ProjectError(404, '项目不存在');
  const now = Date.now();
  const id = newId('chat');
  const modelId = input.modelId ?? defaultModelId();
  const title = input.title?.trim() || titleForProject(project.name);
  sqlite()
    .prepare(
      'insert into chat (id, project_id, title, model_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
    )
    .run(id, projectId, title, modelId, now, now);
  sqlite().prepare('update project set updated_at = ? where id = ?').run(now, projectId);
  return toChatSummary(chatRow(id)!);
}

export async function openProject(workspacePath: string) {
  let checked: { workspacePath: string; name: string };
  try {
    checked = await validateWorkspacePath(workspacePath);
  } catch (error) {
    if (error instanceof WorkspaceError) throw new ProjectError(error.status, error.message);
    throw error;
  }
  const existing = sqlite()
    .prepare('select * from project where workspace_path = ?')
    .get(checked.workspacePath) as ProjectRow | undefined;
  if (existing) {
    // 已有项目直接复用，不重复建项目或初始对话。
    const chats = listChats(existing.id);
    if (chats.length === 0) createChat(existing.id);
    return { project: await projectFromRow(existing), chats: listChats(existing.id) };
  }
  const now = Date.now();
  const id = newId('proj');
  sqlite()
    .prepare(
      'insert into project (id, name, description, template_id, workspace_path, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, checked.name, '本地目录', 'local', checked.workspacePath, now, now);
  await indexedFiles(id, checked.workspacePath);
  createChat(id);
  return { project: await getProject(id), chats: listChats(id) };
}

export function renameProject(projectId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectError(400, '项目名称不能为空');
  const result = sqlite()
    .prepare('update project set name = ?, updated_at = ? where id = ?')
    .run(trimmed, Date.now(), projectId);
  if (result.changes === 0) throw new ProjectError(404, '项目不存在');
}

export async function deleteProject(projectId: string) {
  const row = getProjectRow(projectId);
  if (!row) throw new ProjectError(404, '项目不存在');
  const running = sqlite()
    .prepare(
      "select count(*) as count from agent_run where chat_id in (select id from chat where project_id = ?) and status in ('running','awaiting_approval')",
    )
    .get(projectId) as { count: number };
  if (running.count > 0) throw new ProjectError(409, '项目还有运行中的对话，暂时不能删除');
  const runs = sqlite()
    .prepare('select r.id from agent_run r join chat c on c.id = r.chat_id where c.project_id = ?')
    .all(projectId) as { id: string }[];
  // 先清理可重试的磁盘数据，失败时保留数据库记录，用户可再次删除。
  try {
    await rm(projectDataDir(projectId), { recursive: true, force: true });
    await Promise.all(
      runs.map((run) => rm(commandOutputDir(run.id), { recursive: true, force: true })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(500, `清理项目数据失败，项目记录已保留，请重试：${message}`);
  }
  // 用户目录不做任何改动，只清理本应用的记录。
  sqlite().prepare('delete from project where id = ?').run(projectId);
}

export function messagesForChat(chatId: string): Message[] {
  const rows = sqlite()
    .prepare('select * from message where chat_id = ? order by seq asc')
    .all(chatId) as MessageRow[];
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: JSON.parse(row.parts) as Message['parts'],
    createdAt: iso(row.created_at)!,
    finishedAt: iso(row.finished_at),
    changeSetId: row.change_set_id ?? undefined,
    ...(row.status ? { status: row.status } : {}),
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
  }));
}

export function latestRunForChat(chatId: string) {
  return sqlite()
    .prepare('select * from agent_run where chat_id = ? order by started_at desc limit 1')
    .get(chatId) as
    | {
        id: string;
        status: string;
        assistant_message_id: string;
        stop_reason: string | null;
        error: string | null;
      }
    | undefined;
}

export async function chatBundle(chatId: string): Promise<ChatBundle> {
  const chat = getChatRow(chatId);
  const project = await getProject(chat.project_id);
  const catalog = await discoverSkills({ projectPath: project.workspacePath });
  return {
    project,
    chat: toChatSummary(chat),
    chats: listChats(chat.project_id),
    messages: messagesForChat(chatId),
    skills: catalog.skills,
    models: configuredModels(),
  };
}

export async function ensureProjectChat(projectId: string, chatId: string) {
  const chat = getChatRow(chatId);
  if (chat.project_id !== projectId) throw new ProjectError(404, '对话不属于该项目');
  return chat;
}

/** 删除对话前先确认没有运行中的回合。 */
export function deleteChat(chatId: string) {
  const chat = getChatRow(chatId);
  if (activeRun(chatId)) throw new ProjectError(409, '对话还有运行中的回合');
  sqlite().prepare('delete from chat where id = ?').run(chatId);
  return chat.project_id;
}

export async function ensureDataDirectory() {
  await mkdir(`${process.cwd()}/data/projects`, { recursive: true });
}
