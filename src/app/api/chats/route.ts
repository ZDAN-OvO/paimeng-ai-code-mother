import { createDraftRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { appendUserMessage, createDraft, listArchivedChats } from '@/mock/world';
import { startRound } from '@/mock/scenario';

export const dynamic = 'force-dynamic';

/** `?archived=1` 返回归档列表；不带参数时这个端点只用于新建草稿。 */
export const GET = withErrors(async (request: Request) => {
  const archived = new URL(request.url).searchParams.get('archived');
  if (archived !== '1') return json({ chats: [] });
  return json({ chats: listArchivedChats() });
});

/** 首页一句话与模板卡都走这里：先建草稿并立刻开始首轮，用户之后再决定要不要变成项目。 */
export const POST = withErrors(async (request: Request) => {
  const body = await parseBody(request, createDraftRequestSchema);
  const chat = createDraft(body);
  appendUserMessage(chat.id, body.prompt);
  const accepted = startRound(chat.id, body.prompt);
  return json({ chat, eventsUrl: accepted.eventsUrl }, 201);
});
