import { json, withErrors } from '@/mock/http';
import { listDrafts } from '@/mock/world';

export const dynamic = 'force-dynamic';

/** 侧栏「草稿」：还没决定变成项目的会话。 */
export const GET = withErrors(async () => json({ chats: listDrafts() }));
