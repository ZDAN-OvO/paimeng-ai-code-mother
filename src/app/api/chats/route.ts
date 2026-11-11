import { archivedChatsResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { listArchivedChats } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async (request: Request) => {
  const archived = new URL(request.url).searchParams.get('archived');
  if (archived !== '1') return json(archivedChatsResponseSchema.parse({ chats: [] }));
  return json(archivedChatsResponseSchema.parse({ chats: listArchivedChats() }));
});
