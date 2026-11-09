import { describe, expect, it } from 'vitest';
import {
  canComplete,
  completionReviewed,
  finishRound,
  isLargeChange,
  skillKey,
  sourceRevision,
} from './flow';
import { seedProjects } from './seed/projects';
import type { ChatRecord, Part } from '@/shared/api/schemas';

describe('mock 回合契约', () => {
  it('源码改动后旧证据失效', () => {
    const files = { 'page.tsx': 'before' };
    const evidence = sourceRevision(files);
    expect(canComplete(files, evidence)).toBe(true);
    expect(canComplete({ 'page.tsx': 'after' }, evidence)).toBe(false);
    expect(canComplete(files, null)).toBe(false);
  });

  it('内置技能与用户技能同名也要区分', () => {
    expect(skillKey({ source: 'builtin', slug: 'nextjs' })).not.toBe(
      skillKey({ source: 'user', slug: 'nextjs' }),
    );
  });

  it('中断的回合也落成版本，且不重写历史', () => {
    const initial = seedProjects().chats[0];
    const message = {
      id: 'reply',
      role: 'assistant' as const,
      parts: [] as Part[],
      createdAt: '2026-11-07',
    };
    const chat: ChatRecord = {
      ...initial,
      messages: [...initial.messages, message],
      liveFiles: { 'partial.tsx': 'saved work' },
    };
    const stopped = finishRound(
      chat,
      'reply',
      'stopped',
      'stopped',
      initial.versions[0].site,
      'saved',
      '2026-11-07',
    );
    expect(stopped.versions.at(-1)?.files).toEqual({ 'partial.tsx': 'saved work' });
    expect(stopped.messages.at(-1)?.status).toBe('stopped');
    expect(stopped.versions.length).toBe(initial.versions.length + 1);
    expect(initial.versions.length).toBe(chat.versions.length);
    expect(
      finishRound(stopped, 'reply', 'stopped', '', initial.versions[0].site, 'dup', '').versions
        .length,
    ).toBe(stopped.versions.length);
  });

  it('首轮或改三个以上文件算大改动，小改动只跑 CI', () => {
    expect(isLargeChange({}, { 'a.tsx': '1' })).toBe(true);
    expect(isLargeChange({ 'a.tsx': '1' }, { 'a.tsx': '2' })).toBe(false);
    expect(isLargeChange({ 'a.tsx': '1' }, { 'a.tsx': '2', 'b.tsx': '1', 'c.tsx': '1' })).toBe(
      true,
    );
  });

  it('completion review 只对通过时的修订有效，也只在成功时算数', () => {
    const files = { 'page.tsx': 'v1' };
    const reviewed = sourceRevision(files);
    expect(completionReviewed('succeeded', files, reviewed)).toBe(true);
    expect(completionReviewed('succeeded', { 'page.tsx': 'v2' }, reviewed)).toBe(false);
    expect(completionReviewed('succeeded', files, null)).toBe(false);
    expect(completionReviewed('failed', files, reviewed)).toBe(false);
  });

  it('中断时仍在运行的审查标成出错，并记下有没有经过完成审查', () => {
    const initial = seedProjects().chats[0];
    const review: Part = {
      id: 'r1',
      type: 'review',
      kind: 'code',
      round: 1,
      revision: 'rev-1',
      scope: 'app/page.tsx',
      state: 'running',
    };
    const chat: ChatRecord = {
      ...initial,
      messages: [
        ...initial.messages,
        { id: 'reply', role: 'assistant', parts: [review], createdAt: '2026-11-09' },
      ],
    };
    const next = finishRound(chat, 'reply', 'stopped', '', initial.versions[0].site, 'v', '');
    const message = next.messages.at(-1);
    expect(message?.completionReviewed).toBe(false);
    expect(message?.parts[0]).toMatchObject({ type: 'review', state: 'error' });
  });
});
