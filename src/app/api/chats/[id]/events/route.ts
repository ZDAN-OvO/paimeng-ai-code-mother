import type { SseEvent } from '@/shared/api/schemas';
import { getRun, sseResponse } from '@/mock/runs';
import { findChat } from '@/mock/world';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun<SseEvent>(`chat:${id}`);
  if (!run) {
    return Response.json({ error: '这个对话当前没有生成中的回合' }, { status: 404 });
  }
  const requested = Number(new URL(request.url).searchParams.get('since') ?? '0');
  const since = Math.max(0, Number.isFinite(requested) ? requested : 0);
  const messageId = run.meta.messageId;
  const message = messageId
    ? (findChat(id).messages.find((item) => item.id === messageId) ?? null)
    : null;
  // 客户端晚连时先收到权威快照，再补它之后产生的事件。
  const cursor = Math.max(since, run.events.length);
  return sseResponse<SseEvent>(run, cursor, { seq: cursor, type: 'snapshot', message });
}
