import { chatBundleSchema, chatSummarySchema, patchChatRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { chatBundle, getChatRow, toChatSummary } from '@/server/projects';
import { sqlite } from '@/server/db';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return json(chatBundleSchema.parse(await chatBundle(id)));
});

export const PATCH = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, patchChatRequestSchema);
  const row = getChatRow(id);
  const title = body.title?.trim() || row.title;
  const modelId = body.modelId?.trim() || row.model_id;
  sqlite()
    .prepare('update chat set title = ?, model_id = ?, updated_at = ? where id = ?')
    .run(title, modelId, Date.now(), id);
  return json(chatSummarySchema.parse(toChatSummary(getChatRow(id))));
});
