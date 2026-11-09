import { createChatRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { createChat, findChatByProject, summaryOf } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return json({ chats: findChatByProject(id).map(summaryOf) });
});

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, createChatRequestSchema);
  return json(createChat(id, body), 201);
});
