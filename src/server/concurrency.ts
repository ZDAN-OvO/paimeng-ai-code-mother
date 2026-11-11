type Gate = {
  paused: boolean;
  active: Set<Promise<unknown>>;
  waiters: (() => void)[];
};

const gates = new Map<string, Gate>();

function gate(projectId: string) {
  let value = gates.get(projectId);
  if (!value) {
    value = { paused: false, active: new Set(), waiters: [] };
    gates.set(projectId, value);
  }
  return value;
}

function wake(projectId: string) {
  const value = gate(projectId);
  if (value.paused) return;
  const waiters = value.waiters.splice(0);
  for (const resolve of waiters) resolve();
}

/** 所有项目内文件写入和 Bash 执行都经过这个闸门。 */
export async function withProjectWrite<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const value = gate(projectId);
  if (value.paused) {
    await new Promise<void>((resolve) => value.waiters.push(resolve));
  }
  let release!: () => void;
  const marker = new Promise<void>((resolve) => {
    release = resolve;
  });
  value.active.add(marker);
  try {
    return await task();
  } finally {
    value.active.delete(marker);
    release();
    wake(projectId);
  }
}

export function projectPaused(projectId: string) {
  return gate(projectId).paused;
}

/**
 * 撤销优先：暂停新写入，等待正在提交的短操作完成，再执行恢复。
 * Bash 由调用方先终止；这里负责文件写入的收尾。
 */
export async function pauseProject<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const value = gate(projectId);
  value.paused = true;
  try {
    await Promise.allSettled([...value.active]);
    return await task();
  } finally {
    value.paused = false;
    wake(projectId);
  }
}

export async function waitForProjectIdle(projectId: string) {
  const value = gate(projectId);
  while (value.active.size > 0 || value.paused) {
    if (value.paused) return;
    await Promise.allSettled([...value.active]);
  }
}
