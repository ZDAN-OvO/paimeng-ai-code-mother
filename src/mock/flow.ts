import type {
  ChangeSet,
  ChatRecord,
  FileMap,
  RunStatus,
  SiteState,
  Skill,
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
 * 主 agent 判断「大改动」的 mock 规则：首轮生成或一次改动三个及以上文件。
 * 大改动在 CI 之后调用 code review，交付前调用 completion review；小改动只跑 CI。
 */
export function isLargeChange(before: FileMap, after: FileMap) {
  return Object.keys(before).length === 0 || changedPaths(before, after).length >= 3;
}

/** completion review 只对通过时的那一版修订有效；之后再改文件就不算审过。 */
export function completionReviewed(status: RunStatus, files: FileMap, reviewed: string | null) {
  return status === 'succeeded' && reviewed !== null && reviewed === sourceRevision(files);
}

export type WorkspaceSnapshot = { files: FileMap; site: SiteState | null };

/**
 * 一轮结束时收尾：把这一轮的工具状态收尾，并把项目文件的变化记成一条改动记录。
 * 计划、调研、没有动文件的轮次不产生记录；记录里的 before/after 之后用于 diff 与安全撤销。
 */
export function finishRound(
  chat: ChatRecord,
  messageId: string,
  status: RunStatus,
  summary: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  meta: { changeSetId: string; seq: number; now: string; reviewed?: boolean },
): { chat: ChatRecord; changeSet: ChangeSet | null } {
  const message = chat.messages.find((item) => item.id === messageId);
  if (!message || message.changeSetId) return { chat, changeSet: null };

  const changedFiles = changedPaths(before.files, after.files);
  const changeSet: ChangeSet | null =
    changedFiles.length === 0
      ? null
      : {
          id: meta.changeSetId,
          seq: meta.seq,
          chatId: chat.id,
          messageId,
          summary,
          createdAt: meta.now,
          status: 'applied',
          changedFiles,
          before: before.files,
          after: after.files,
          siteBefore: before.site,
          siteAfter: after.site,
        };

  return {
    chat: {
      ...chat,
      streaming: false,
      updatedAt: meta.now,
      messages: chat.messages.map((item) =>
        item.id !== messageId
          ? item
          : {
              ...item,
              streaming: false,
              status,
              completionReviewed: meta.reviewed ?? false,
              finishedAt: meta.now,
              changeSetId: changeSet?.id,
              parts: item.parts.map((part) =>
                part.type === 'tool' && part.state === 'running'
                  ? {
                      ...part,
                      state: 'error',
                      output: '本轮已中断；已完成的改动保留在项目文件里。',
                    }
                  : part.type === 'review' && part.state === 'running'
                    ? { ...part, state: 'error', findings: ['本轮已中断，审查没有给出结论。'] }
                    : part,
              ),
            },
      ),
    },
    changeSet,
  };
}
