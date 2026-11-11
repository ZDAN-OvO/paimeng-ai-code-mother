import { chatSummarySchema, createChatRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { createChat } from '@/server/projects';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, createChatRequestSchema);
  return json(chatSummarySchema.parse(createChat(id, body)), 201);
});
