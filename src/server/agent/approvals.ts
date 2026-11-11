import { sqlite } from '@/server/db';

type Decision = 'approved' | 'rejected';

type Pending = {
  runId: string;
  resolve: (decision: Decision) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();

export class ApprovalAbortedError extends Error {
  constructor() {
    super('等待批准已中断');
    this.name = 'ApprovalAbortedError';
  }
}

export type ApprovalRow = {
  id: string;
  run_id: string;
  chat_id: string;
  tool_call_id: string;
  command: string;
  cwd: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
};

function markExpired(approvalId: string) {
  sqlite()
    .prepare(
      "update approval set status = 'expired', decided_at = ? where id = ? and status = 'pending'",
    )
    .run(Date.now(), approvalId);
}

export async function requestApproval(input: {
  approvalId: string;
  runId: string;
  chatId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  reason: string;
  signal?: AbortSignal;
}): Promise<Decision> {
  const approvalId = input.approvalId;
  sqlite()
    .prepare(
      'insert into approval (id, run_id, chat_id, tool_call_id, command, cwd, reason, status) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      approvalId,
      input.runId,
      input.chatId,
      input.toolCallId,
      input.command,
      input.cwd,
      input.reason,
      'pending',
    );
  const promise = new Promise<Decision>((resolve, reject) => {
    pending.set(approvalId, { runId: input.runId, resolve, reject });
    if (input.signal?.aborted) {
      pending.delete(approvalId);
      markExpired(approvalId);
      reject(new ApprovalAbortedError());
      return;
    }
    input.signal?.addEventListener(
      'abort',
      () => {
        const entry = pending.get(approvalId);
        if (!entry) return;
        pending.delete(approvalId);
        markExpired(approvalId);
        entry.reject(new ApprovalAbortedError());
      },
      { once: true },
    );
  });
  return promise;
}

/** 只有 pending 能改变；重复或过期请求不会二次执行。 */
export function decideApproval(approvalId: string, decision: Decision) {
  const result = sqlite()
    .prepare("update approval set status = ?, decided_at = ? where id = ? and status = 'pending'")
    .run(decision, Date.now(), approvalId);
  const row = sqlite().prepare('select * from approval where id = ?').get(approvalId) as
    ApprovalRow | undefined;
  if (!row) return { changed: false, approval: null };
  const entry = pending.get(approvalId);
  if (result.changes > 0 && entry) {
    pending.delete(approvalId);
    entry.resolve(decision);
    return { changed: true, approval: row };
  }
  return { changed: false, approval: row };
}

export function pendingApproval(approvalId: string) {
  return pending.get(approvalId) ?? null;
}

export function cancelRunApprovals(runId: string) {
  for (const [id, entry] of pending) {
    if (entry.runId !== runId) continue;
    pending.delete(id);
    markExpired(id);
    entry.reject(new ApprovalAbortedError());
  }
}

export function cancelProjectApprovals(projectId: string) {
  const rows = sqlite()
    .prepare(
      `select a.id from approval a join agent_run r on r.id = a.run_id
       join chat c on c.id = r.chat_id
       where c.project_id = ? and a.status = 'pending'`,
    )
    .all(projectId) as { id: string }[];
  for (const row of rows) {
    const entry = pending.get(row.id);
    pending.delete(row.id);
    markExpired(row.id);
    entry?.reject(new ApprovalAbortedError());
  }
}

export function expireStaleApprovals() {
  const rows = sqlite().prepare("select id from approval where status = 'pending'").all() as {
    id: string;
  }[];
  for (const row of rows) {
    const entry = pending.get(row.id);
    pending.delete(row.id);
    markExpired(row.id);
    entry?.reject(new ApprovalAbortedError());
  }
}
