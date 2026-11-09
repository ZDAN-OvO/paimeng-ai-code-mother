import { describe, expect, it } from 'vitest';
import { createSseParser } from './client';

describe('SSE 解析', () => {
  it('跨分片拼回一条事件，并忽略非 data 行', () => {
    const events: string[] = [];
    const feed = createSseParser<{ type: string }>((event) => events.push(event.type));
    feed('data: {"type":"snap');
    feed('shot"}\n\n: keep-alive\n\n');
    feed('data: {"type":"finish"}\n\n');
    expect(events).toEqual(['snapshot', 'finish']);
  });
});
