import { changedPaths } from './diff';
import type { Chat, FileMap, RunStatus, SiteState, Skill } from './types';

export function skillKey(skill: Pick<Skill, 'source' | 'slug'>) {
  return `${skill.source}:${skill.slug}`;
}

export function sourceRevision(files: FileMap) {
  const source = JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `mock-${(hash >>> 0).toString(16)}`;
}

export function canComplete(files: FileMap, evidence: string | null) {
  return evidence !== null && evidence === sourceRevision(files);
}

/** Each completed assistant message keeps a snapshot, including unchanged or partial work. */
export function finishRound(
  chat: Chat,
  messageId: string,
  status: RunStatus,
  summary: string,
  fallbackSite: SiteState,
  id: string,
  now: string,
): Chat {
  const message = chat.messages.find((item) => item.id === messageId);
  if (!message || message.versionId) return chat;
  const previous = chat.versions.at(-1);
  const files = { ...(chat.liveFiles ?? previous?.files ?? {}) };
  const version = {
    id,
    chatId: chat.id,
    messageId,
    seq: chat.versions.length + 1,
    label: `v${chat.versions.length + 1}`,
    summary,
    createdAt: now,
    files,
    site: chat.liveSite ?? previous?.site ?? fallbackSite,
    changedFiles: changedPaths(previous?.files ?? {}, files),
  };
  return {
    ...chat,
    streaming: false,
    updatedAt: now,
    liveFiles: undefined,
    liveSite: undefined,
    versions: [...chat.versions, version],
    activeVersionId: id,
    viewVersionId: id,
    messages: chat.messages.map((item) =>
      item.id !== messageId
        ? item
        : {
            ...item,
            streaming: false,
            status,
            finishedAt: now,
            versionId: id,
            parts: item.parts.map((part) =>
              part.type === 'tool' && part.state === 'running'
                ? { ...part, state: 'error', output: '本轮已中断；保留已完成的本地改动。' }
                : part,
            ),
          },
    ),
  };
}
