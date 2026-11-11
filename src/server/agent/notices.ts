type Notice = {
  id: number;
  text: string;
  deliveredTo: Set<string>;
  createdAt: number;
};

const undoNotices = new Map<string, Notice[]>();
let nextId = 1;
const MAX_NOTICES = 50;

/** 用户撤销后通知同项目正在运行的 Agent 重新读取，不要自动重做。 */
export function notifyUndo(projectId: string, paths: string[]) {
  const list = undoNotices.get(projectId) ?? [];
  list.push({
    id: nextId++,
    text: `用户撤销了以下文件，请重新读取后再决定下一步，不要自动重做这些改动：${paths.join('、')}`,
    deliveredTo: new Set(),
    createdAt: Date.now(),
  });
  while (list.length > MAX_NOTICES) list.shift();
  undoNotices.set(projectId, list);
}

/**
 * 每个运行轮次独立领取通知。一次撤销要通知同项目所有相关 Agent，
 * 不能被先到的一轮取走后让其他轮次错过。
 */
export function takeUndoNotices(projectId: string, runId: string) {
  const list = undoNotices.get(projectId) ?? [];
  const fresh = list.filter((notice) => !notice.deliveredTo.has(runId));
  for (const notice of fresh) notice.deliveredTo.add(runId);
  return fresh.map((notice) => notice.text);
}

/** 测试和进程内清理用。 */
export function clearUndoNotices() {
  undoNotices.clear();
}
