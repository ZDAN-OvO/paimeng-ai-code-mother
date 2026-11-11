import { approvalDecisionRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { decideApproval } from '@/server/agent/approvals';
import { reflectApproval } from '@/server/agent/runner';
import { sqlite } from '@/server/db';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string; runId: string; approvalId: string }> };

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id, runId, approvalId } = await params;
  const body = await parseBody(request, approvalDecisionRequestSchema);
  const row = sqlite()
    .prepare('select chat_id, run_id from approval where id = ?')
    .get(approvalId) as { chat_id: string; run_id: string } | undefined;
  if (!row || row.chat_id !== id || row.run_id !== runId) {
    return json({ error: '审批不存在' }, 404);
  }
  const result = decideApproval(approvalId, body.decision);
  if (!result.changed || !result.approval) {
    return json({ error: '审批已处理或已过期，不会再次执行' }, 409);
  }
  reflectApproval(approvalId, body.decision);
  return json({ ok: true, approval: result.approval });
});
