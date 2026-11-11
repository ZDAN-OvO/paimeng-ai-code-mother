import { api } from '@/lib/api/client';
import type { ChatSummary, ProjectSummary } from '@/shared/api/schemas';

/** 最近项目入口：有上一轮对话就直接打开，没有就新建一个空对话。 */
export async function openProjectChat(project: ProjectSummary): Promise<string> {
  if (project.lastChatId) return project.lastChatId;
  const chat = await api.post<ChatSummary>(`/api/projects/${project.id}/chats`, {});
  return chat.id;
}
