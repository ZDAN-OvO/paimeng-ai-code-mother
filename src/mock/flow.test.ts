import { describe, expect, it } from 'vitest';
import { canComplete, finishRound, skillKey, sourceRevision } from './flow';
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
});
