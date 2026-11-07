import { describe, expect, it } from 'vitest';
import { createProjectRequestSchema, sseEventSchema } from './schemas';

describe('对外契约', () => {
  it('建项目时 templateId 缺省为 auto', () => {
    expect(createProjectRequestSchema.parse({ prompt: '做一个官网' })).toEqual({
      prompt: '做一个官网',
      templateId: 'auto',
    });
  });

  it('SSE 事件必须带 seq 与已知类型', () => {
    expect(sseEventSchema.parse({ seq: 1, type: 'snapshot', message: null }).type).toBe('snapshot');
    expect(sseEventSchema.safeParse({ type: 'snapshot', message: null }).success).toBe(false);
  });
});
