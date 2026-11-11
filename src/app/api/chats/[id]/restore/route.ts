import { chatSummarySchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { getChatRow, toChatSummary } from '@/server/projects';
import { sqlite } from '@/server/db';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const POST = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  getChatRow(id);
  const now = Date.now();
  sqlite().prepare('update chat set archived_at = null, updated_at = ? where id = ?').run(now, id);
  return json(chatSummarySchema.parse(toChatSummary(getChatRow(id))));
});
