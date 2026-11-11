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
import type { ChatRecord, Part, SiteState } from '@/shared/api/schemas';

const SITE: SiteState = {
  iteration: 1,
  layout: 1,
  content: {
    brand: '示例',
    headline: '标题',
    tagline: '一句话',
    cta: '开始',
    nav: ['功能'],
    features: [],
    detailTitle: '详情',
    details: [],
    testimonial: { quote: '', author: '' },
    footerNote: '',
  },
};

function chatWithReply(parts: Part[] = []): ChatRecord {
  const initial = seedProjects().chats[0];
  return {
    ...initial,
    messages: [
      ...initial.messages,
      { id: 'reply', role: 'assistant', parts, createdAt: '2026-11-11T10:00:00+08:00' },
    ],
  };
}

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

  it('被中断的回合也留下改动记录，记录撤销前的项目文件', () => {
    const chat = chatWithReply();
    const { chat: stopped, changeSet } = finishRound(
      chat,
      'reply',
      'stopped',
      'stopped',
      { files: { 'app/page.tsx': 'v1' }, site: SITE },
      { files: { 'app/page.tsx': 'v1', 'partial.tsx': 'saved work' }, site: SITE },
      { changeSetId: 'cs_2', seq: 2, now: '2026-11-11T10:01:00+08:00' },
    );
    expect(changeSet).toMatchObject({
      id: 'cs_2',
      seq: 2,
      chatId: chat.id,
      messageId: 'reply',
      status: 'applied',
      changedFiles: ['partial.tsx'],
      before: { 'app/page.tsx': 'v1' },
      after: { 'app/page.tsx': 'v1', 'partial.tsx': 'saved work' },
    });
    expect(stopped.messages.at(-1)?.status).toBe('stopped');
    expect(stopped.messages.at(-1)?.changeSetId).toBe('cs_2');
    // 原始对象不被就地改写，撤销记录仍然可用。
    expect(chat.messages.at(-1)?.changeSetId).toBeUndefined();
  });

  it('本轮没有动文件时不生成改动记录', () => {
    const chat = chatWithReply();
    const { changeSet, chat: next } = finishRound(
      chat,
      'reply',
      'awaiting_approval',
      '只做计划',
      { files: { 'app/page.tsx': 'v1' }, site: SITE },
      { files: { 'app/page.tsx': 'v1' }, site: SITE },
      { changeSetId: 'cs_plan', seq: 4, now: '2026-11-11T10:01:00+08:00' },
    );
    expect(changeSet).toBeNull();
    expect(next.messages.at(-1)?.changeSetId).toBeUndefined();
  });

  it('已收尾的消息不会再记第二笔改动', () => {
    const chat = chatWithReply();
    const first = finishRound(
      chat,
      'reply',
      'succeeded',
      'ok',
      { files: {}, site: null },
      { files: { 'a.tsx': '1' }, site: SITE },
      { changeSetId: 'cs_1', seq: 2, now: '2026-11-11T10:01:00+08:00' },
    );
    const again = finishRound(
      first.chat,
      'reply',
      'succeeded',
      'ok',
      { files: {}, site: null },
      { files: { 'a.tsx': '1' }, site: SITE },
      { changeSetId: 'cs_dup', seq: 3, now: '2026-11-11T10:02:00+08:00' },
    );
    expect(again.changeSet).toBeNull();
    expect(again.chat).toBe(first.chat);
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
    const review: Part = {
      id: 'r1',
      type: 'review',
      kind: 'code',
      round: 1,
      revision: 'rev-1',
      scope: 'app/page.tsx',
      state: 'running',
    };
    const next = finishRound(
      chatWithReply([review]),
      'reply',
      'stopped',
      '',
      { files: {}, site: null },
      { files: {}, site: null },
      { changeSetId: 'v', seq: 1, now: '' },
    );
    const message = next.chat.messages.at(-1);
    expect(message?.completionReviewed).toBe(false);
    expect(message?.parts[0]).toMatchObject({ type: 'review', state: 'error' });
  });
});
