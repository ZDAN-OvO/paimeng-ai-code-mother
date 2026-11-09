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

  it('review 片段与 finish 的完成审查标记', () => {
    const review = {
      id: 'r1',
      type: 'review',
      kind: 'code',
      round: 1,
      revision: 'rev-1',
      scope: 'app/page.tsx',
      state: 'done',
      verdict: 'changes_requested',
      findings: ['按钮缺少可读名称'],
    };
    expect(
      sseEventSchema.parse({ seq: 2, type: 'part-added', messageId: 'm', part: review }).type,
    ).toBe('part-added');
    expect(
      sseEventSchema.safeParse({
        seq: 3,
        type: 'part-added',
        messageId: 'm',
        part: { ...review, kind: 'style' },
      }).success,
    ).toBe(false);
    const finish = {
      seq: 4,
      type: 'finish',
      messageId: 'm',
      status: 'succeeded',
      summary: '',
      versionId: null,
    };
    expect(sseEventSchema.safeParse(finish).success).toBe(false);
    expect(sseEventSchema.parse({ ...finish, completionReviewed: false }).type).toBe('finish');
  });
});
