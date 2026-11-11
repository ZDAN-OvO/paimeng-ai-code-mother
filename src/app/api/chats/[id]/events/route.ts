import { messageSchema, type Message, type SseEvent } from '@/shared/api/schemas';
import { activeRunForChat, recoverInterruptedRuns } from '@/server/agent/runner';
import { subscribe } from '@/server/agent/events';
import { getChatRow, latestRunForChat, messagesForChat } from '@/server/projects';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

function encode(controller: ReadableStreamDefaultController<Uint8Array>, event: SseEvent) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    getChatRow(id);
  } catch {
    return Response.json({ error: '对话不存在' }, { status: 404 });
  }
  await recoverInterruptedRuns();
  const active = activeRunForChat(id);
  const since = Math.max(0, Number(new URL(request.url).searchParams.get('since') ?? '0') || 0);
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };

  if (!active) {
    const latest = latestRunForChat(id);
    const messages = messagesForChat(id);
    const message = latest
      ? messages.find((item) => item.id === latest.assistant_message_id)
      : messages.at(-1);
    const runId = latest?.id ?? `chat-${id}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        encode(controller, {
          seq: 0,
          runId,
          type: 'snapshot',
          message: message ? messageSchema.parse(message) : null,
          run: latest
            ? {
                id: latest.id,
                status: latest.status as
                  'running' | 'awaiting_approval' | 'succeeded' | 'stopped' | 'failed',
                messageId: latest.assistant_message_id,
              }
            : null,
        });
        if (message) {
          encode(controller, {
            seq: 1,
            runId,
            type: 'finish',
            messageId: message.id,
            status: message.status ?? 'succeeded',
            stopReason: message.stopReason ?? null,
            summary: message.changeSetId ? '本轮已结束，可在改动中查看文件差异' : '本轮已结束',
            changeSetId: message.changeSetId ?? null,
            error: message.error ?? null,
          });
        }
        controller.close();
      },
    });
    return new Response(stream as unknown as BodyInit, { headers });
  }

  const runId = active.runId;
  const snapshotSeq = Math.max(since, active.seq);
  // 快照与订阅之间没有 await，保证快照之后的事件全部进入缓冲，不会丢事件。
  const snapshotParts = JSON.parse(JSON.stringify(active.parts)) as Message['parts'];
  let live = false;
  let lastSeq = snapshotSeq;
  const buffered: SseEvent[] = [];
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const closeController = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close();
    } catch {
      /* 已关闭 */
    }
  };
  const unsubscribe = subscribe(active.projectId, (event) => {
    if (event.runId !== runId && event.type !== 'files-changed') return;
    const seq = event.seq > 0 ? event.seq : ++lastSeq;
    lastSeq = Math.max(lastSeq, seq);
    if (seq <= snapshotSeq) return;
    if (!live) {
      buffered.push({ ...event, runId, seq });
      return;
    }
    if (closed) return;
    if (event.type === 'finish') closed = true;
    encode(controllerRef!, { ...event, runId, seq });
    if (closed) {
      unsubscribe();
      closeController(controllerRef!);
    }
  });

  const message: Message = {
    id: active.assistantMessageId,
    role: 'assistant',
    parts: snapshotParts,
    createdAt: new Date().toISOString(),
    streaming: true,
    status: active.awaitingApproval ? 'awaiting_approval' : 'running',
  };
  const snapshot: SseEvent = {
    seq: snapshotSeq,
    runId,
    type: 'snapshot',
    message: messageSchema.parse(message),
    run: {
      id: runId,
      status: active.awaitingApproval ? 'awaiting_approval' : 'running',
      messageId: active.assistantMessageId,
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      encode(controller, snapshot);
      for (const event of buffered.splice(0)) {
        if (closed) break;
        if (event.type === 'finish') closed = true;
        encode(controller, event);
      }
      live = true;
      if (closed) {
        unsubscribe();
        closeController(controller);
        return;
      }
      request.signal.addEventListener(
        'abort',
        () => {
          unsubscribe();
          closeController(controller);
        },
        { once: true },
      );
    },
  });
  return new Response(stream as unknown as BodyInit, { headers });
}
