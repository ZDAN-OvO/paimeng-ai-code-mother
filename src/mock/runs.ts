/**
 * 服务端事件流：一次生成或一次发布对应一个 Run，事件先落进数组再推给订阅者，
 * 所以刷新或重连可以从头补发，不需要客户端自己拼状态。
 */
export type EventRun<T> = {
  events: T[];
  done: boolean;
  abort: boolean;
  listeners: Set<() => void>;
  meta: { messageId?: string; chatId?: string };
  close: () => void;
};

// 与 world 同理：route 各自打包，切换路由时要能从同一张表里找到进行中的 run。
const runs: Map<string, EventRun<unknown>> = ((
  globalThis as { __paimengMockRuns?: Map<string, EventRun<unknown>> }
).__paimengMockRuns ??= new Map());

export function openRun<T>(key: string, meta: EventRun<T>['meta'] = {}): EventRun<T> {
  const run: EventRun<T> = {
    events: [],
    done: false,
    abort: false,
    meta,
    listeners: new Set(),
    close: () => {
      run.done = true;
      for (const notify of run.listeners) notify();
      run.listeners.clear();
    },
  };
  runs.set(key, run as EventRun<unknown>);
  return run;
}

export function getRun<T>(key: string): EventRun<T> | undefined {
  return runs.get(key) as EventRun<T> | undefined;
}

export function pushEvent<T>(run: EventRun<T>, event: T): T {
  run.events.push(event);
  for (const notify of run.listeners) notify();
  return event;
}

/** 从 since 开始补齐已有事件，然后等待新事件，run 关闭后结束。 */
export async function* drainEvents<T>(run: EventRun<T>, since = 0): AsyncGenerator<T> {
  let index = Math.max(0, since);
  while (true) {
    while (index < run.events.length) {
      yield run.events[index];
      index += 1;
    }
    if (run.done) return;
    await new Promise<void>((resolve) => {
      const notify = () => {
        run.listeners.delete(notify);
        resolve();
      };
      run.listeners.add(notify);
    });
  }
}

export function sseResponse<T>(run: EventRun<T>, since = 0, preamble?: T): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 先给一条当前状态，晚连的客户端不必自己重放历史事件。
        if (preamble !== undefined) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(preamble)}\n\n`));
        }
        since = Math.max(since, 0);
        for await (const event of drainEvents(run, since)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
