import { describe, expect, it } from 'vitest';
import { createProjectRequestSchema, projectSchema, sseEventSchema } from './schemas';

const project = {
  id: 'proj_1',
  name: '山间咖啡',
  description: '做一个咖啡馆官网',
  templateId: 'coffee',
  workspacePath: '~/Projects/山间咖啡',
  workspaceState: 'sample',
  createdAt: '2026-11-11T09:00:00+08:00',
  updatedAt: '2026-11-11T09:00:00+08:00',
  env: [],
  files: { 'app/page.tsx': 'export default function Page() { return null; }' },
  site: null,
  changeSets: [],
  runtime: { state: 'stopped', port: null, url: null, logs: [], source: 'sample' },
};

describe('对外契约', () => {
  it('建项目需要本地目录，模板缺省为 auto', () => {
    expect(createProjectRequestSchema.parse({ workspacePath: '~/Projects/foo' })).toEqual({
      workspacePath: '~/Projects/foo',
      prompt: '',
      templateId: 'auto',
    });
    expect(createProjectRequestSchema.safeParse({}).success).toBe(false);
  });

  it('项目以本地目录和共享文件状态为身份，不再有发布与版本快照', () => {
    expect(projectSchema.parse(project).workspacePath).toBe('~/Projects/山间咖啡');
    const { workspacePath, ...withoutPath } = project;
    expect(workspacePath).toBe('~/Projects/山间咖啡');
    expect(projectSchema.safeParse(withoutPath).success).toBe(false);
    expect('deployKey' in projectSchema.parse(project)).toBe(false);
    expect('versions' in projectSchema.parse(project)).toBe(false);
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
      changeSetId: null,
    };
    expect(sseEventSchema.safeParse(finish).success).toBe(false);
    expect(sseEventSchema.parse({ ...finish, completionReviewed: false }).type).toBe('finish');
  });
});
