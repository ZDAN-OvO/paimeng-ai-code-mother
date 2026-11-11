import { json, withErrors } from '@/mock/http';
import { listArchivedChats } from '@/mock/world';

export const dynamic = 'force-dynamic';

/** `?archived=1` 返回归档列表；对话不能脱离项目新建，所以这里没有 POST。 */
export const GET = withErrors(async (request: Request) => {
  const archived = new URL(request.url).searchParams.get('archived');
  if (archived !== '1') return json({ chats: [] });
  return json({ chats: listArchivedChats() });
});
