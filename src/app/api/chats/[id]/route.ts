import { patchChatRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { getBundle, patchChat } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return json(getBundle(id));
});

export const PATCH = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, patchChatRequestSchema);
  return json(patchChat(id, body));
});
