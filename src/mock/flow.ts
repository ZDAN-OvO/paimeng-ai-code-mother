import type {
  ChatRecord,
  FileMap,
  RunStatus,
  SiteState,
  Skill,
  Version,
} from '@/shared/api/schemas';
import { changedPaths } from '@/lib/diff';

export function skillKey(skill: Pick<Skill, 'source' | 'slug'>) {
  return `${skill.source}:${skill.slug}`;
}

/** 源码修订指纹：检查证据绑定到它，改动后旧证据自动失效。 */
export function sourceRevision(files: FileMap) {
  const source = JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `rev-${(hash >>> 0).toString(16)}`;
}

export function canComplete(files: FileMap, evidence: string | null) {
  return evidence !== null && evidence === sourceRevision(files);
}

/**
 * 一轮结束时收尾：把工作区落成一个版本（计划、调研、中途停止也各自留版本），
 * 并把仍在 running 的工具标成中断。
 */
export function finishRound(
  chat: ChatRecord,
  messageId: string,
  status: RunStatus,
  summary: string,
  fallbackSite: SiteState,
  id: string,
  now: string,
): ChatRecord {
  const message = chat.messages.find((item) => item.id === messageId);
  if (!message || message.versionId) return chat;
  const previous = chat.versions.at(-1);
  const files = { ...(chat.liveFiles ?? previous?.files ?? {}) };
  const version: Version = {
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
                ? { ...part, state: 'error', output: '本轮已中断；已完成的改动保留在版本里。' }
                : part,
            ),
          },
    ),
  };
}
